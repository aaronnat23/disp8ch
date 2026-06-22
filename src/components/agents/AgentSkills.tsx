"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AgentSkillPack,
  AgentExtensionPack,
  IntegrationPreset,
  AgentFile,
  AgentRole,
  AgentTab,
  SKILL_FILE_GUIDE,
} from "./types";

export function AgentSkills({
  skillPacks,
  extensionPacks,
  integrationPresets,
  toolsLoading,
  filesLoading,
  savingTools,
  enabledSkillPacks,
  enabledExtensions,
  configuredSkillFiles,
  sortedIntegrationPresets,
  skillFileEntries,
  files,
  selectedAgentRole,
  selectedAgentId,
  onToggleSkillPack,
  onToggleExtensionPack,
  applyIntegrationPreset,
  loadTools,
  loadFiles,
  setSelectedFileName,
  setActiveTab,
}: {
  skillPacks: AgentSkillPack[];
  extensionPacks: AgentExtensionPack[];
  integrationPresets: IntegrationPreset[];
  toolsLoading: boolean;
  filesLoading: boolean;
  savingTools: boolean;
  enabledSkillPacks: number;
  enabledExtensions: number;
  configuredSkillFiles: number;
  sortedIntegrationPresets: IntegrationPreset[];
  skillFileEntries: Array<{
    name: string;
    title: string;
    description: string;
    file: AgentFile | null;
    configured: boolean;
  }>;
  files: AgentFile[];
  selectedAgentRole: AgentRole | null;
  selectedAgentId: string | null;
  onToggleSkillPack: (skillId: string, enabled: boolean) => Promise<void>;
  onToggleExtensionPack: (extensionId: string, enabled: boolean) => Promise<void>;
  applyIntegrationPreset: (presetId: string, mode?: "merge" | "replace") => Promise<void>;
  loadTools: (agentId: string) => Promise<void>;
  loadFiles: (agentId: string) => Promise<void>;
  setSelectedFileName: (name: string | null) => void;
  setActiveTab: (tab: AgentTab) => void;
}) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Enabled Extensions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{enabledExtensions}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Enabled Skill Packs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{enabledSkillPacks}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Configured Skill Files</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{configuredSkillFiles}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Starter Presets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Apply a bundled extension + skill setup in one step. This is the quickest way to give an agent a ready tool workflow.
          </p>
          {toolsLoading && sortedIntegrationPresets.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading presets...</p>
          ) : sortedIntegrationPresets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No presets available.</p>
          ) : (
            <div className="space-y-2">
              {sortedIntegrationPresets.map((preset) => {
                const recommended = selectedAgentRole?.roleType
                  ? preset.recommendedRoleTypes?.includes(selectedAgentRole.roleType) ?? false
                  : false;
                return (
                  <div
                    key={preset.id}
                    className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div>
                      <div className="mb-1 flex items-center gap-2">
                        <div className="text-sm font-medium">{preset.name}</div>
                        <Badge variant="outline">{preset.extensions.length} ext</Badge>
                        <Badge variant="outline">{preset.skills.length} skills</Badge>
                        {recommended ? <Badge>recommended</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{preset.description}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {preset.extensions.join(", ")} · {preset.skills.join(", ")}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void applyIntegrationPreset(preset.id)}
                      disabled={savingTools}
                    >
                      Apply
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Extension Packs</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => selectedAgentId && void loadTools(selectedAgentId)}
              disabled={toolsLoading}
            >
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Global extension lifecycle now lives in the Extensions tab. Use this panel to attach globally enabled extensions to the selected agent.
          </p>
          {toolsLoading && extensionPacks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading extensions...</p>
          ) : extensionPacks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No extension packs found.</p>
          ) : (
            <div className="space-y-2">
              {extensionPacks.map((extension) => (
                <div
                  key={extension.id}
                  className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <div className="text-sm font-medium">{extension.name}</div>
                      <Badge variant="outline">{extension.source}</Badge>
                      <Badge variant={extension.enabled ? "default" : "secondary"}>
                        {extension.enabled ? "enabled" : "disabled"}
                      </Badge>
                      {extension.globallyEnabled === false ? <Badge variant="outline">global off</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{extension.description}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {extension.id} • {extension.skillCount} skill pack{extension.skillCount === 1 ? "" : "s"}
                      {extension.configurable ? " • configurable" : ""}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={extension.enabled}
                      disabled={savingTools || extension.globallyEnabled === false}
                      onChange={(event) =>
                        void onToggleExtensionPack(extension.id, event.target.checked)
                      }
                    />
                    enabled
                  </label>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Skill Packs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Skill packs are reusable instruction bundles. Enabled packs are injected into the agent runtime before each run.
          </p>
          {toolsLoading && skillPacks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading skill packs...</p>
          ) : skillPacks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No packaged skill packs found.</p>
          ) : (
            <div className="space-y-2">
              {skillPacks.map((skill) => {
                const extensionEnabled = skill.extensionId
                  ? (
                    extensionPacks.find((entry) => entry.id === skill.extensionId)?.enabled &&
                    extensionPacks.find((entry) => entry.id === skill.extensionId)?.globallyEnabled !== false
                  ) ?? false
                  : true;
                return (
                  <div
                    key={skill.id}
                    className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div>
                      <div className="mb-1 flex items-center gap-2">
                        <div className="text-sm font-medium">{skill.label}</div>
                        <Badge variant="outline">{skill.source}</Badge>
                        {skill.extensionId ? (
                          <Badge variant={extensionEnabled ? "secondary" : "outline"}>
                            {skill.extensionId}
                          </Badge>
                        ) : null}
                        {skill.globallyEnabled === false ? <Badge variant="outline">global off</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{skill.description}</div>
                      <div className="text-[11px] text-muted-foreground">{skill.id}</div>
                    </div>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        disabled={savingTools || !extensionEnabled}
                        onChange={(event) =>
                          void onToggleSkillPack(skill.id, event.target.checked)
                        }
                      />
                      enabled
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Skill Files</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline">
                {configuredSkillFiles}/{skillFileEntries.length} configured
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => selectedAgentId && void loadFiles(selectedAgentId)}
                disabled={filesLoading}
              >
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            In disp8ch, skill behavior is shaped by these workspace markdown files. Edit them to tune persona,
            memory behavior, and tool policy.
          </p>
          {filesLoading && files.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading skill files...</p>
          ) : (
            <div className="space-y-2">
              {skillFileEntries.map((entry) => (
                <div
                  key={entry.name}
                  className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <div className="text-sm font-medium">{entry.title}</div>
                      <Badge variant={entry.configured ? "default" : "outline"}>
                        {entry.configured ? "configured" : "missing"}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">{entry.description}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {entry.name}
                      {entry.file && !entry.file.missing ? ` • ${entry.file.size ?? 0} bytes` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelectedFileName(entry.name);
                      setActiveTab("files");
                    }}
                  >
                    Edit
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
