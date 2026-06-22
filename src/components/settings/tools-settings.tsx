"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Code2, FlaskConical, Loader2, Plus, Shield, Terminal, Trash2, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { TOOL_POLICY_PRESETS, TOOL_RISK_LEVEL } from "@/lib/engine/tool-policy-metadata";

type ToolType = "bash" | "javascript";
type WrapperMode = "manual" | "generated";
type OutputMode = "text" | "json";
type ValidationStatus = "untested" | "passed" | "failed";

interface CustomTool {
  id: string;
  name: string;
  description: string;
  type: ToolType;
  code: string;
  parameters: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  wrapperMode: WrapperMode;
  commandTemplate: string | null;
  outputMode: OutputMode;
  outputSchema: Record<string, unknown> | null;
  sampleArgs: Record<string, unknown> | null;
  validationStatus: ValidationStatus;
  validationError: string | null;
  lastValidatedAt: string | null;
  lastOutputPreview: string | null;
}

type ToolPreview = {
  ok: boolean;
  output: string;
  validationStatus: ValidationStatus;
  validationError: string | null;
};

type ToolFormState = {
  name: string;
  description: string;
  type: ToolType;
  code: string;
  parametersText: string;
  wrapperMode: WrapperMode;
  commandTemplate: string;
  outputMode: OutputMode;
  outputSchemaText: string;
  sampleArgsText: string;
};

const PARAMETER_SCHEMA_TEMPLATE = `{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Example argument"
    }
  },
  "required": []
}`;

const JSON_OUTPUT_SCHEMA_TEMPLATE = `{
  "type": "object",
  "properties": {
    "ok": { "type": "boolean" },
    "items": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": ["ok"]
}`;

const SAMPLE_ARGS_TEMPLATE = `{
  "name": "world"
}`;

const MANUAL_BASH_PLACEHOLDER = `# Use {{args.param_name}} to reference inputs
# Example: echo "Hello, {{args.name}}"
# Use {{args_json}} for all args as JSON
echo "Running with args: {{args_json}}"`;

const JS_PLACEHOLDER = `// args is available as an object
// Set output to return structured content
const result = { ok: true, greeting: "Hello, " + args.name };
output = JSON.stringify(result);`;

const WRAPPER_PLACEHOLDER = `gh issue list --limit {{args.limit}} --json number,title,state`;

const BLANK_FORM: ToolFormState = {
  name: "",
  description: "",
  type: "bash",
  code: "",
  parametersText: PARAMETER_SCHEMA_TEMPLATE,
  wrapperMode: "manual",
  commandTemplate: "",
  outputMode: "text",
  outputSchemaText: "",
  sampleArgsText: SAMPLE_ARGS_TEMPLATE,
};

function parseJsonField(
  label: string,
  value: string,
  options?: { allowEmpty?: boolean },
): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: options?.allowEmpty ? null : {} };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `${label} must be a JSON object.` };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `${label} is not valid JSON: ${String(error)}` };
  }
}

function prettyJson(value: Record<string, unknown> | null | undefined): string {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value, null, 2);
}

function validationBadge(status: ValidationStatus) {
  if (status === "passed") {
    return <Badge variant="outline" className="text-xs border-green-500/40 text-green-600">validated</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="outline" className="text-xs border-terminal-red/40 text-terminal-red">failed</Badge>;
  }
  return <Badge variant="secondary" className="text-xs">untested</Badge>;
}

export function ToolsSettings() {
  const [tools, setTools] = useState<CustomTool[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTool, setNewTool] = useState<ToolFormState>({ ...BLANK_FORM });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingDraft, setTestingDraft] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ToolPreview | null>(null);

  const fetchTools = () => {
    fetch("/api/tools")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setTools(d.data as CustomTool[]);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchTools();
  }, []);

  function resetForm() {
    setNewTool({ ...BLANK_FORM });
    setPreview(null);
    setError("");
  }

  function setWrapperMode(wrapperMode: WrapperMode) {
    setPreview(null);
    setNewTool((previous) => ({
      ...previous,
      wrapperMode,
      type: wrapperMode === "generated" ? "bash" : previous.type,
      outputMode: wrapperMode === "generated" ? "json" : previous.outputMode,
      outputSchemaText: wrapperMode === "generated" && !previous.outputSchemaText.trim()
        ? JSON_OUTPUT_SCHEMA_TEMPLATE
        : previous.outputSchemaText,
    }));
  }

  function buildPayload() {
    const parameters = parseJsonField("Parameter schema", newTool.parametersText);
    if (!parameters.ok) {
      setError(parameters.error);
      return null;
    }
    const outputSchema = parseJsonField("Output schema", newTool.outputSchemaText, { allowEmpty: true });
    if (!outputSchema.ok) {
      setError(outputSchema.error);
      return null;
    }
    const sampleArgs = parseJsonField("Sample args", newTool.sampleArgsText, { allowEmpty: true });
    if (!sampleArgs.ok) {
      setError(sampleArgs.error);
      return null;
    }
    const payload = {
      name: newTool.name.trim(),
      description: newTool.description.trim(),
      type: newTool.wrapperMode === "generated" ? "bash" : newTool.type,
      code: newTool.wrapperMode === "manual" ? newTool.code : undefined,
      parameters: parameters.value ?? {},
      wrapperMode: newTool.wrapperMode,
      commandTemplate: newTool.wrapperMode === "generated" ? newTool.commandTemplate.trim() : null,
      outputMode: newTool.outputMode,
      outputSchema: outputSchema.value,
      sampleArgs: sampleArgs.value,
    };
    return payload;
  }

  async function testDraft() {
    setError("");
    setPreview(null);
    const payload = buildPayload();
    if (!payload) return;
    if (!payload.name || !payload.description) {
      setError("Name and description are required.");
      return;
    }
    if (payload.wrapperMode === "manual" && !String(payload.code || "").trim()) {
      setError("Code is required.");
      return;
    }
    if (payload.wrapperMode === "generated" && !String(payload.commandTemplate || "").trim()) {
      setError("Command template is required.");
      return;
    }
    setTestingDraft(true);
    try {
      const sampleArgs = parseJsonField("Sample args", newTool.sampleArgsText, { allowEmpty: true });
      if (!sampleArgs.ok) {
        setError(sampleArgs.error);
        return;
      }
      const res = await fetch("/api/tools/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: payload,
          args: sampleArgs.value ?? {},
        }),
      });
      const data = await res.json() as { success: boolean; error?: string; data?: ToolPreview };
      if (!data.success || !data.data) {
        setError(data.error ?? "Failed to test tool");
        return;
      }
      setPreview(data.data);
    } finally {
      setTestingDraft(false);
    }
  }

  async function addTool() {
    setError("");
    const payload = buildPayload();
    if (!payload) return;
    if (!payload.name || !payload.description) {
      setError("Name and description are required.");
      return;
    }
    if (payload.wrapperMode === "manual" && !String(payload.code || "").trim()) {
      setError("Code is required.");
      return;
    }
    if (payload.wrapperMode === "generated" && !String(payload.commandTemplate || "").trim()) {
      setError("Command template is required.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (!data.success) {
        setError(data.error ?? "Failed to create tool");
        return;
      }
      setAdding(false);
      resetForm();
      fetchTools();
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(tool: CustomTool) {
    setError("");
    const res = await fetch(`/api/tools?id=${tool.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !tool.isActive }),
    });
    const data = await res.json() as { success: boolean; error?: string };
    if (!data.success) {
      setError(data.error ?? "Failed to update tool");
      return;
    }
    fetchTools();
  }

  async function deleteTool(id: string) {
    await fetch(`/api/tools?id=${id}`, { method: "DELETE" });
    fetchTools();
  }

  async function retestTool(tool: CustomTool) {
    setError("");
    setTestingId(tool.id);
    try {
      const res = await fetch("/api/tools/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tool.id, args: tool.sampleArgs ?? {} }),
      });
      const data = await res.json() as { success: boolean; error?: string; data?: ToolPreview };
      if (!data.success || !data.data) {
        setError(data.error ?? "Failed to re-test tool");
        return;
      }
      setPreview(data.data);
      setExpanded(tool.id);
      fetchTools();
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Tool Policy Presets</CardTitle>
          <CardDescription>
            Quickly configure which built-in tools are available to agents. Choose a preset or
            customize individually below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs min-w-[180px]"
              onChange={(e) => {
                const preset = TOOL_POLICY_PRESETS[e.target.value];
                if (!preset) return;
                if (preset.tools[0] === "*") {
                  // Full operator: enable all tools — just set all known tools active
                  fetch("/api/tools")
                    .then((r) => r.json())
                    .then((d) => {
                      if (d.success && Array.isArray(d.data)) {
                        const allIds = d.data.map((t: { id: string }) => t.id);
                        Promise.all(allIds.map((id: string) =>
                          fetch(`/api/tools?id=${id}`, {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ isActive: true }),
                          })
                        )).then(() => fetchTools());
                      }
                    })
                    .catch(() => {});
                } else {
                  // Enable only preset tools via the API
                  fetch("/api/tools")
                    .then((r) => r.json())
                    .then((d) => {
                      if (d.success && Array.isArray(d.data)) {
                        const presetSet = new Set(preset.tools);
                        Promise.all(
                          d.data.map((t: { id: string; name: string; isActive: boolean }) => {
                            const shouldBeActive = presetSet.has(t.name);
                            if (shouldBeActive !== t.isActive) {
                              return fetch(`/api/tools?id=${t.id}`, {
                                method: "PUT",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ isActive: shouldBeActive }),
                              });
                            }
                            return Promise.resolve();
                          })
                        ).then(() => fetchTools());
                      }
                    })
                    .catch(() => {});
                }
                e.target.value = "";
              }}
            >
              <option value="">Apply a preset...</option>
              {Object.entries(TOOL_POLICY_PRESETS).map(([key, preset]) => (
                <option key={key} value={key} title={preset.description}>{preset.label} — {preset.description}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom Tools</CardTitle>
          <CardDescription>
            Build tools the same way agents already understand this app: bash snippets, sandboxed JavaScript, or
            generated CLI wrappers with structured JSON output and sample-run verification before activation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <div className="rounded-md border border-terminal-red/40 bg-terminal-red/5 px-3 py-2 text-xs text-terminal-red">
              {error}
            </div>
          ) : null}

          {tools.length === 0 && !adding ? (
            <p className="text-sm text-muted-foreground">
              No custom tools yet. Add one below and agents will be able to call it alongside the built-in tools.
            </p>
          ) : null}

          {tools.map((tool) => (
            <div key={tool.id} className="rounded-lg border">
              <div
                className="flex cursor-pointer items-center justify-between p-3 select-none"
                onClick={() => setExpanded(expanded === tool.id ? null : tool.id)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {tool.wrapperMode === "generated"
                    ? <Wand2 className="h-3.5 w-3.5 shrink-0 text-terminal-red" />
                    : tool.type === "bash"
                      ? <Terminal className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                      : <Code2 className="h-3.5 w-3.5 shrink-0 text-yellow-400" />}
                  <span className="truncate font-mono text-sm font-medium">{tool.name}</span>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {tool.wrapperMode === "generated" ? "wrapper" : tool.type}
                  </Badge>
                  {tool.type !== "javascript" && tool.type !== "bash" ? null : (() => {
                    const risk = TOOL_RISK_LEVEL[tool.name] || { level: "moderate", reason: "Tool execution" };
                    return (
                      <Badge variant="outline" className={`shrink-0 text-[9px] ${
                        risk.level === "high" ? "border-red-500/40 text-red-400"
                        : risk.level === "safe" ? "border-emerald-500/40 text-emerald-400"
                        : "border-amber-500/40 text-amber-400"
                      }`}>
                        {risk.level}
                      </Badge>
                    );
                  })()}
                  {validationBadge(tool.validationStatus)}
                  {!tool.isActive ? <Badge variant="secondary" className="shrink-0 text-xs">disabled</Badge> : null}
                </div>
                <div className="ml-2 flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleActive(tool);
                    }}
                    title={tool.isActive ? "Disable tool" : "Enable tool"}
                  >
                    <span className="text-xs">{tool.isActive ? "✓" : "○"}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(event) => {
                      event.stopPropagation();
                      void retestTool(tool);
                    }}
                    disabled={testingId === tool.id}
                    title="Run saved sample test"
                  >
                    {testingId === tool.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteTool(tool.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                  {expanded === tool.id
                    ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
              </div>

              {expanded === tool.id ? (
                <div className="space-y-3 border-t p-3">
                  <p className="text-xs text-muted-foreground">{tool.description}</p>
                  {tool.validationError ? (
                    <div className="rounded-md border border-terminal-red/30 bg-terminal-red/5 px-3 py-2 text-xs text-terminal-red">
                      {tool.validationError}
                    </div>
                  ) : null}
                  {tool.lastValidatedAt ? (
                    <div className="text-[11px] text-muted-foreground">
                      Last validated {new Date(tool.lastValidatedAt).toLocaleString()}
                    </div>
                  ) : null}
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Command / Code</Label>
                      <pre className="max-h-56 overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap">
                        {tool.wrapperMode === "generated" ? tool.commandTemplate || tool.code : tool.code}
                      </pre>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Parameter Schema</Label>
                      <pre className="max-h-56 overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap">
                        {JSON.stringify(tool.parameters, null, 2)}
                      </pre>
                    </div>
                    {tool.outputMode === "json" ? (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Output Schema</Label>
                        <pre className="max-h-56 overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap">
                          {JSON.stringify(tool.outputSchema ?? {}, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {tool.sampleArgs ? (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Sample Args</Label>
                        <pre className="max-h-56 overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap">
                          {JSON.stringify(tool.sampleArgs, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {tool.lastOutputPreview ? (
                      <div className="space-y-1.5 lg:col-span-2">
                        <Label className="text-xs">Last Test Output</Label>
                        <pre className="max-h-56 overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap">
                          {tool.lastOutputPreview}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ))}

          <Separator />

          {adding ? (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">New Custom Tool</div>
                  <div className="text-xs text-muted-foreground">
                    Generated wrappers are best for existing CLIs. Manual tools stay useful for freeform scripts.
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={newTool.wrapperMode === "generated" ? "default" : "outline"}
                    onClick={() => setWrapperMode("generated")}
                  >
                    <Wand2 className="mr-1 h-3.5 w-3.5" />
                    CLI Wrapper
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={newTool.wrapperMode === "manual" ? "default" : "outline"}
                    onClick={() => setWrapperMode("manual")}
                  >
                    <Code2 className="mr-1 h-3.5 w-3.5" />
                    Manual Script
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Tool Name (snake_case)</Label>
                  <Input
                    placeholder="e.g. list_open_prs"
                    value={newTool.name}
                    onChange={(event) => setNewTool((previous) => ({ ...previous, name: event.target.value }))}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Output Mode</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={newTool.outputMode}
                    onChange={(event) => setNewTool((previous) => ({ ...previous, outputMode: event.target.value as OutputMode }))}
                  >
                    <option value="text">Text</option>
                    <option value="json">Structured JSON</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Description</Label>
                <Input
                  placeholder="Explain what the tool does and which arguments it expects"
                  value={newTool.description}
                  onChange={(event) => setNewTool((previous) => ({ ...previous, description: event.target.value }))}
                />
              </div>

              {newTool.wrapperMode === "manual" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Type</Label>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={newTool.type}
                      onChange={(event) => setNewTool((previous) => ({ ...previous, type: event.target.value as ToolType }))}
                    >
                      <option value="bash">Bash / Shell</option>
                      <option value="javascript">JavaScript (sandboxed)</option>
                    </select>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    Manual tools stay flexible. If you want the app to validate a stable CLI contract, use the wrapper
                    mode instead.
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-terminal-red/20 bg-terminal-red/5 px-3 py-2 text-xs text-muted-foreground">
                  Wrapper tools generate a reusable CLI contract on top of a command template and stay inactive until a
                  sample run passes.
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="text-xs">
                  {newTool.wrapperMode === "generated"
                    ? "Command Template"
                    : newTool.type === "bash"
                      ? "Bash Command / Script"
                      : "JavaScript Code"}
                </Label>
                <Textarea
                  rows={7}
                  className="font-mono text-xs"
                  placeholder={
                    newTool.wrapperMode === "generated"
                      ? WRAPPER_PLACEHOLDER
                      : newTool.type === "bash"
                        ? MANUAL_BASH_PLACEHOLDER
                        : JS_PLACEHOLDER
                  }
                  value={newTool.wrapperMode === "generated" ? newTool.commandTemplate : newTool.code}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setNewTool((previous) => previous.wrapperMode === "generated"
                      ? { ...previous, commandTemplate: nextValue }
                      : { ...previous, code: nextValue });
                  }}
                />
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Parameter Schema</Label>
                  <Textarea
                    rows={10}
                    className="font-mono text-xs"
                    value={newTool.parametersText}
                    onChange={(event) => setNewTool((previous) => ({ ...previous, parametersText: event.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Sample Args</Label>
                  <Textarea
                    rows={10}
                    className="font-mono text-xs"
                    value={newTool.sampleArgsText}
                    onChange={(event) => setNewTool((previous) => ({ ...previous, sampleArgsText: event.target.value }))}
                  />
                </div>
              </div>

              {newTool.outputMode === "json" ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">JSON Output Schema</Label>
                  <Textarea
                    rows={10}
                    className="font-mono text-xs"
                    placeholder={JSON_OUTPUT_SCHEMA_TEMPLATE}
                    value={newTool.outputSchemaText}
                    onChange={(event) => setNewTool((previous) => ({ ...previous, outputSchemaText: event.target.value }))}
                  />
                </div>
              ) : null}

              {preview ? (
                <div className={`rounded-md border px-3 py-2 text-xs ${preview.ok ? "border-green-500/30 bg-green-500/5" : "border-terminal-red/30 bg-terminal-red/5"}`}>
                  <div className="mb-2 flex items-center gap-2 font-medium">
                    {preview.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> : <AlertCircle className="h-3.5 w-3.5 text-terminal-red" />}
                    {preview.ok ? "Sample run passed" : "Sample run failed"}
                  </div>
                  {preview.validationError ? (
                    <div className="mb-2 text-terminal-red">{preview.validationError}</div>
                  ) : null}
                  <pre className="max-h-56 overflow-auto rounded bg-background/70 p-2 font-mono whitespace-pre-wrap">
                    {preview.output}
                  </pre>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void testDraft()} disabled={testingDraft}>
                  {testingDraft ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-1 h-4 w-4" />}
                  Test Tool
                </Button>
                <Button type="button" size="sm" onClick={() => void addTool()} disabled={saving}>
                  {saving ? "Saving..." : "Create Tool"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAdding(false);
                    resetForm();
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="mr-1 h-4 w-4" />
              Add Custom Tool
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How Custom Tools Work</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Active custom tools appear beside built-in tools in agent runs. Generated wrappers are the safest fit when
            you are wrapping an existing CLI because they can carry an argument schema, sample args, and an optional
            JSON output contract.
          </p>
          <p>
            <strong className="text-foreground">Generated wrappers</strong> use a command template and can validate the
            command&apos;s output against a JSON schema before the tool is enabled for agents.
          </p>
          <p>
            <strong className="text-foreground">Manual bash tools</strong> run with shell-escaped arguments via
            <code className="rounded bg-muted px-1 text-xs font-mono">{" {{args.param_name}} "}</code> and
            <code className="rounded bg-muted px-1 text-xs font-mono">{" {{args_json}} "}</code>.
          </p>
          <p>
            <strong className="text-foreground">Manual JavaScript tools</strong> run inside a restricted
            <code className="rounded bg-muted px-1 text-xs font-mono"> vm.runInNewContext()</code> sandbox with no
            direct file-system or network access.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
