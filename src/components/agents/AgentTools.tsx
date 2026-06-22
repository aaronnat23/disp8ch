"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentTool } from "./types";

export function AgentTools({
  tools,
  toolsLoading,
  savingTools,
  toolFilter,
  setToolFilter,
  filteredTools,
  enabledTools,
  onToggleTool,
  setAllTools,
}: {
  tools: AgentTool[];
  toolsLoading: boolean;
  savingTools: boolean;
  toolFilter: string;
  setToolFilter: (value: string) => void;
  filteredTools: AgentTool[];
  enabledTools: number;
  onToggleTool: (toolName: string, enabled: boolean) => Promise<void>;
  setAllTools: (enabled: boolean) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Tool Access</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{enabledTools}/{tools.length} enabled</Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void setAllTools(true)}
              disabled={savingTools}
            >
              Enable All
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void setAllTools(false)}
              disabled={savingTools}
            >
              Disable All
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Default behavior: built-in tools are available to an agent unless you disable them here.
          Use <span className="font-medium text-foreground">Disable All</span> or individual toggles for
          tighter profiles; risky execution is still governed by runtime approval and execution policy.
        </div>
        <Input
          placeholder="Filter tools"
          value={toolFilter}
          onChange={(event) => setToolFilter(event.target.value)}
        />
        {toolsLoading ? (
          <p className="text-sm text-muted-foreground">Loading tools...</p>
        ) : filteredTools.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tools found.</p>
        ) : (
          <div className="space-y-2">
            {filteredTools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <div className="text-sm font-medium">{tool.label}</div>
                    <Badge variant="outline">{tool.source}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{tool.description}</div>
                  <div className="text-[11px] text-muted-foreground">{tool.name}</div>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={tool.enabled}
                    onChange={(event) =>
                      void onToggleTool(tool.name, event.target.checked)
                    }
                    disabled={savingTools}
                  />
                  enabled
                </label>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
