"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface DepartmentSummary {
  id: string;
  name: string;
  slug: string;
  tier: string;
  focusArea: string;
  status: string;
  vaultRoot: string;
  members: Array<{ role: string; agentId: string }>;
  workflows: Array<{ kind: string; workflowId: string }>;
}

export function DepartmentCard({
  dept,
  onTestRun,
  onTogglePause,
  onDelete,
  busy,
}: {
  dept: DepartmentSummary;
  onTestRun: (id: string) => void;
  onTogglePause: (id: string, paused: boolean) => void;
  onDelete: (id: string) => void;
  busy?: boolean;
}) {
  const paused = dept.status === "paused";
  return (
    <Card className="border-terminal-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{dept.name}</CardTitle>
          <div className="flex items-center gap-1">
            <Badge variant="outline">{dept.tier}</Badge>
            <Badge variant={paused ? "secondary" : "default"}>{dept.status}</Badge>
          </div>
        </div>
        <p className="text-xs text-terminal-muted">{dept.focusArea}</p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap gap-2">
          {dept.members.map((m) => (
            <Link key={m.role} href={`/agents?agent=${encodeURIComponent(m.agentId)}`} className="rounded border border-terminal-border px-2 py-0.5 capitalize hover:border-terminal-red">
              {m.role}: {m.agentId}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-terminal-muted">
          {dept.workflows.map((w) => (
            <Link key={w.workflowId} href={`/workflows?id=${encodeURIComponent(w.workflowId)}`} className="rounded border border-terminal-border px-2 py-0.5 hover:border-terminal-red">
              {w.kind}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-terminal-muted">
          <span className="font-mono">{dept.vaultRoot}</span>
          <Link href="/scheduler" className="underline hover:text-terminal-red">Automations</Link>
          <Link href="/usage" className="underline hover:text-terminal-red">Usage</Link>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onTestRun(dept.id)}>
            Test Run
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onTogglePause(dept.id, !paused)}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => onDelete(dept.id)}>
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
