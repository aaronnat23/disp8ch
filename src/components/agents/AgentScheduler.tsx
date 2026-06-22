"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentCronSummary, AgentCronJob } from "./types";

export function AgentScheduler({
  cronSummary,
  cronJobs,
  cronLoading,
  selectedAgentId,
  loadCron,
}: {
  cronSummary: AgentCronSummary;
  cronJobs: AgentCronJob[];
  cronLoading: boolean;
  selectedAgentId: string | null;
  loadCron: (agentId: string) => Promise<void>;
}) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Scheduler Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{cronSummary.totalJobs}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Scheduled</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{cronSummary.scheduledJobs}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Active Workflows</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{cronSummary.activeWorkflows}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Agent Scheduler Jobs</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => selectedAgentId && void loadCron(selectedAgentId)}
              disabled={cronLoading}
            >
              {cronLoading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {cronLoading && cronJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading scheduler jobs...</p>
          ) : cronJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scheduler-trigger workflows target this agent.</p>
          ) : (
            <div className="space-y-2">
              {cronJobs.map((job) => (
                <div key={`${job.workflowId}:${job.nodeId}`} className="rounded-md border px-3 py-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{job.workflowName}</div>
                    <div className="flex items-center gap-2">
                      {!job.workflowActive ? <Badge variant="outline">workflow inactive</Badge> : null}
                      <Badge variant={job.isScheduled ? "default" : "secondary"}>
                        {job.isScheduled ? "scheduled" : "not scheduled"}
                      </Badge>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">{job.label}</div>
                  <div className="text-xs text-muted-foreground">Expression: {job.expression}</div>
                  <div className="text-xs text-muted-foreground">Timezone: {job.timezone}</div>
                  <div className="text-[11px] text-muted-foreground">{job.workflowId}:{job.nodeId}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
