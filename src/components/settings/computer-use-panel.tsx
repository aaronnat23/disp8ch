"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Settings → Computer Use (beta). Truthful status/doctor surface for the
 * optional desktop-control capability. Shows install/enable state, doctor
 * checks, active sessions with the action timeline, and a prominent Stop
 * control. Nothing here runs desktop actions; it observes and controls sessions.
 */

type StatusData = {
  adapter: string;
  enabled: boolean;
  install: { installed: boolean; driver: string | null; version: string | null; reason: string };
  capability: { ready: boolean; doctorStatus: string; reason: string };
};

type DoctorData = {
  overall: string;
  driver: string | null;
  checks: Array<{ name: string; status: string; detail: string }>;
};

type SessionData = {
  id: string;
  status: string;
  label: string | null;
  activeApp: string | null;
  startedAt: string;
  endedAt: string | null;
};

export default function ComputerUsePanel() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [doctor, setDoctor] = useState<DoctorData | null>(null);
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/computer-use/status");
      const json = (await res.json()) as { success: boolean; data?: StatusData };
      if (json.success) setStatus(json.data ?? null);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/computer-use/sessions");
      const json = (await res.json()) as { success: boolean; data?: SessionData[] };
      if (json.success) setSessions(json.data ?? []);
    } catch {
      /* non-fatal */
    }
  }, []);

  const runDoctor = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/computer-use/doctor");
      const json = (await res.json()) as { success: boolean; data?: DoctorData };
      if (json.success) setDoctor(json.data ?? null);
    } finally {
      setBusy(false);
    }
  }, []);

  const stopSession = useCallback(
    async (id: string) => {
      await fetch(`/api/computer-use/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await loadSessions();
    },
    [loadSessions],
  );

  useEffect(() => {
    void loadStatus();
    void loadSessions();
  }, [loadStatus, loadSessions]);

  const enabled = status?.enabled ?? false;
  const installed = status?.install.installed ?? false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Computer Use</CardTitle>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">beta</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Computer Use lets an agent observe and control your desktop through a real backend (Cua). It is optional,
            off by default, and every action is policy-checked and audited. Sensitive actions (payments, deletions,
            credential entry, sending messages) require approval.
          </p>

          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className={enabled ? "text-green-400 border-green-500/40" : "text-muted-foreground"}>
              {enabled ? "enabled" : "disabled"}
            </Badge>
            <Badge variant="outline" className={installed ? "text-green-400 border-green-500/40" : "text-amber-400 border-amber-500/40"}>
              {installed ? `driver: ${status?.install.driver}` : "driver not installed"}
            </Badge>
            <Badge variant="outline" className={status?.capability.ready ? "text-green-400 border-green-500/40" : "text-muted-foreground"}>
              {status?.capability.ready ? "ready" : "not ready"}
            </Badge>
          </div>
          {status?.capability.reason && <p className="text-xs text-muted-foreground">{status.capability.reason}</p>}

          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
            <div className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">Getting started</div>
            <ol className="list-decimal space-y-2 pl-4">
              <li>
                <strong>New install</strong>: add Computer Use during first install. This installs Cua Driver and writes
                only non-secret local flags; Doctor still decides whether it is ready.
                <div className="mt-1 space-y-1">
                  <div className="text-muted-foreground">Windows (PowerShell):</div>
                  <code className="block whitespace-pre-wrap rounded bg-background/60 p-1">$env:DISP8CH_WITH_COMPUTER_USE=&quot;1&quot;; $env:DISP8CH_SOURCE_ZIP_URL=&quot;https://github.com/aaronnat23/disp8ch/archive/refs/heads/main.zip&quot;; iex (irm &quot;https://raw.githubusercontent.com/aaronnat23/disp8ch/main/scripts/install-windows.ps1&quot;)</code>
                  <div className="text-muted-foreground">macOS / Linux:</div>
                  <code className="block whitespace-pre-wrap rounded bg-background/60 p-1">curl -fsSL https://raw.githubusercontent.com/aaronnat23/disp8ch/main/scripts/install.sh | DISP8CH_WITH_COMPUTER_USE=1 bash -s -- --repo https://github.com/aaronnat23/disp8ch.git</code>
                </div>
              </li>
              <li>
                <strong>Existing install</strong>: install only Cua Driver (open-source desktop-control backend — not an
                LLM, not a workflow engine; treat it as optional beta until Doctor passes).
                <div className="mt-1 space-y-1">
                  <div className="text-muted-foreground">Windows (PowerShell):</div>
                  <code className="block whitespace-pre-wrap rounded bg-background/60 p-1">irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex</code>
                  <div className="text-muted-foreground">macOS / Linux:</div>
                  <code className="block whitespace-pre-wrap rounded bg-background/60 p-1">/bin/bash -c &quot;$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)&quot;</code>
                </div>
              </li>
              <li>
                Make sure <code>cua-driver</code> is on PATH. If a WSL-launched shell does not see the installer&apos;s
                PATH update, set the explicit Windows path:
                <code className="mt-1 block whitespace-pre-wrap rounded bg-background/60 p-1">$env:DISP8CH_CUA_DRIVER_CMD=&quot;C:\Users\&lt;you&gt;\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe&quot;</code>
              </li>
              <li><strong>Enable computer use</strong>: set <code>DISP8CH_ENABLE_COMPUTER_USE=1</code> and restart.</li>
              <li><strong>Run Doctor</strong> below and resolve any failing checks.</li>
              <li><strong>Try a safe observe-only task</strong> first (no clicks or typing) before any action that changes state.</li>
            </ol>
          </div>

          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200/90">
            <strong>Windows note:</strong> the driver must run in the same interactive desktop session that owns the apps
            you want to control. A driver launched from WSL or SSH cannot reach the desktop and will report a Doctor
            failure rather than &quot;ready&quot;. Doctor prefers the driver&apos;s in-session health report, so it does
            not show a false &quot;degraded&quot; just because this process can&apos;t open the window station.
          </div>

          <p className="text-xs text-muted-foreground">
            Upstream Cua telemetry is off by default. Set <code>DISP8CH_CUA_TELEMETRY=1</code> only if you want to opt in.
          </p>

          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void loadStatus()}>Refresh status</Button>
            <Button size="sm" onClick={() => void runDoctor()} disabled={busy}>{busy ? "Running…" : "Run doctor"}</Button>
          </div>
        </CardContent>
      </Card>

      {doctor && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Doctor — {doctor.overall}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {doctor.checks.map((c) => (
              <div key={c.name} className="flex items-center gap-2">
                <Badge variant="outline" className={`text-[10px] ${c.status === "pass" ? "text-green-400 border-green-500/40" : c.status === "warn" ? "text-amber-400 border-amber-500/40" : "text-red-400 border-red-500/40"}`}>
                  {c.status}
                </Badge>
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground">{c.detail}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Sessions</CardTitle>
            <Button size="sm" variant="outline" onClick={() => void loadSessions()}>Refresh</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {sessions.length === 0 ? (
            <p className="text-muted-foreground">No computer-use sessions yet.</p>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md border border-border/60 p-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{s.status}</Badge>
                    <span className="truncate font-medium">{s.label || s.id}</span>
                  </div>
                  {s.activeApp && <span className="text-muted-foreground">active app: {s.activeApp}</span>}
                </div>
                {s.status === "active" || s.status === "paused" ? (
                  <Button size="sm" variant="outline" className="border-red-500/40 text-red-400 hover:bg-red-500/10" onClick={() => void stopSession(s.id)}>
                    Stop
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
