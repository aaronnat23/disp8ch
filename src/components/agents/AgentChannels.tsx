"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentChannelStatus, AgentChannelWorkflow } from "./types";

export function AgentChannels({
  channels,
  channelWorkflows,
  channelsLoading,
  connectedChannels,
  selectedAgentId,
  loadChannels,
}: {
  channels: AgentChannelStatus[];
  channelWorkflows: AgentChannelWorkflow[];
  channelsLoading: boolean;
  connectedChannels: number;
  selectedAgentId: string | null;
  loadChannels: (agentId: string) => Promise<void>;
}) {
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Connected Channels</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{connectedChannels}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Agent Channel Routes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{channelWorkflows.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Configured Channels</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{channels.length}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Channel Status</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => selectedAgentId && void loadChannels(selectedAgentId)}
              disabled={channelsLoading}
            >
              {channelsLoading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {channelsLoading && channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading channel status...</p>
          ) : channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channel data found.</p>
          ) : (
            <div className="space-y-2">
              {channels.map((channel) => (
                <div
                  key={channel.id}
                  className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <div className="text-sm font-medium">{channel.label}</div>
                      <Badge
                        variant={
                          channel.connected === true
                            ? "default"
                            : channel.connected === false
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {channel.connected === true
                          ? "connected"
                          : channel.connected === false
                            ? "disconnected"
                            : "n/a"}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">{channel.statusText}</div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>Triggers: {channel.triggeredWorkflows}</div>
                    <div>Outputs: {channel.outboundWorkflows}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Workflow Routes</CardTitle>
        </CardHeader>
        <CardContent>
          {channelWorkflows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No workflows linked to this agent have channel triggers or outputs yet.</p>
          ) : (
            <div className="space-y-2">
              {channelWorkflows.map((workflow) => (
                <div key={workflow.id} className="rounded-md border px-3 py-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{workflow.name}</div>
                    <div className="flex items-center gap-2">
                      {!workflow.isActive ? <Badge variant="outline">inactive</Badge> : null}
                      <Badge variant="secondary">{workflow.id}</Badge>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Trigger channels: {workflow.triggers.length ? workflow.triggers.join(", ") : "none"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Output channels: {workflow.outputs.length ? workflow.outputs.join(", ") : "none"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
