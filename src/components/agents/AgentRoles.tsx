"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ReportsToPicker } from "@/components/agents/ReportsToPicker";
import { AgentRole, AgentRoleDraft, ROLE_TYPE_OPTIONS } from "./types";

export function AgentRoles({
  roles,
  roleDrafts,
  rolesLoading,
  savingRoleId,
  orchestratorRole,
  selectedAgentId,
  onChangeRoleDraft,
  onSaveRole,
  onSetOrchestrator,
  loadRoles,
}: {
  roles: AgentRole[];
  roleDrafts: Record<string, AgentRoleDraft>;
  rolesLoading: boolean;
  savingRoleId: string | null;
  orchestratorRole: AgentRole | null;
  selectedAgentId: string | null;
  onChangeRoleDraft: (agentId: string, patch: Partial<AgentRoleDraft>) => void;
  onSaveRole: (agentId: string) => Promise<void>;
  onSetOrchestrator: (agentId: string) => Promise<void>;
  loadRoles: () => Promise<void>;
}) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Team Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{roles.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Orchestrator</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold">
              {orchestratorRole?.agentName ?? "Not set"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Reporting Links</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {roles.filter((role) => Boolean(role.reportsTo)).length}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Team Map</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadRoles()}
              disabled={rolesLoading}
            >
              {rolesLoading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rolesLoading && roles.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading role assignments...</p>
          ) : roles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents available for role mapping.</p>
          ) : (
            <div className="space-y-4">
              {orchestratorRole ? (
                <div className="rounded-md border border-primary/50 bg-muted/30 px-4 py-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge>Orchestrator</Badge>
                    <span className="text-sm font-semibold">{orchestratorRole.agentName}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {orchestratorRole.roleTitle}
                    {orchestratorRole.roleDescription
                      ? ` — ${orchestratorRole.roleDescription}`
                      : ""}
                  </p>
                </div>
              ) : null}

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {roles
                  .filter((role) => role.roleType !== "orchestrator")
                  .map((role) => {
                    const manager = role.reportsTo
                      ? roles.find((entry) => entry.agentId === role.reportsTo) ?? null
                      : null;
                    return (
                      <div
                        key={`map-${role.agentId}`}
                        className={`rounded-md border px-3 py-2 ${
                          selectedAgentId === role.agentId ? "border-primary bg-muted/30" : ""
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <div className="text-sm font-medium">{role.agentName}</div>
                          <Badge variant="outline">{role.roleType}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">{role.roleTitle}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Reports to: {manager?.agentName || "none"}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Role Assignment</CardTitle>
        </CardHeader>
        <CardContent>
          {roles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No role records.</p>
          ) : (
            <div className="space-y-3">
              {roles.map((role) => {
                const draft = roleDrafts[role.agentId];
                if (!draft) return null;
                const reportTargets = roles.filter((entry) => entry.agentId !== role.agentId);
                return (
                  <div key={`edit-${role.agentId}`} className="rounded-md border px-3 py-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold">{role.agentName}</div>
                        <div className="text-xs text-muted-foreground">{role.agentId}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {role.roleType !== "orchestrator" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void onSetOrchestrator(role.agentId)}
                            disabled={savingRoleId === role.agentId}
                          >
                            Set Orchestrator
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          onClick={() => void onSaveRole(role.agentId)}
                          disabled={savingRoleId === role.agentId}
                        >
                          {savingRoleId === role.agentId ? "Saving..." : "Save"}
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Role Type</Label>
                        <select
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={draft.roleType}
                          onChange={(event) =>
                            onChangeRoleDraft(role.agentId, {
                              roleType: event.target.value as "orchestrator" | "operations" | "specialist" | "worker" | "support",
                              reportsTo:
                                event.target.value === "orchestrator"
                                  ? null
                                  : draft.reportsTo,
                            })
                          }
                        >
                          {ROLE_TYPE_OPTIONS.map((option) => (
                            <option key={`${role.agentId}-${option.value}`} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label>Reports To</Label>
                        <ReportsToPicker
                          agents={reportTargets.map((t) => ({
                            id: t.agentId,
                            name: t.agentName,
                            role: t.roleType,
                            isActive: t.agentActive,
                          }))}
                          value={draft.reportsTo}
                          onChange={(id) =>
                            onChangeRoleDraft(role.agentId, { reportsTo: id })
                          }
                          disabled={draft.roleType === "orchestrator"}
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label>Role Title</Label>
                        <Input
                          value={draft.roleTitle}
                          onChange={(event) =>
                            onChangeRoleDraft(role.agentId, { roleTitle: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label>Capabilities (comma separated)</Label>
                        <Input
                          value={draft.capabilitiesText}
                          onChange={(event) =>
                            onChangeRoleDraft(role.agentId, { capabilitiesText: event.target.value })
                          }
                          placeholder="routing, delegation, qa, monitoring"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <Label>Role Description</Label>
                        <Textarea
                          rows={3}
                          value={draft.roleDescription}
                          onChange={(event) =>
                            onChangeRoleDraft(role.agentId, { roleDescription: event.target.value })
                          }
                          placeholder="What this agent is responsible for."
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
