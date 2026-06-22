"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type Kind = "briefing" | "scheduled-workflow" | "health-check";
type Cadence = "daily" | "weekdays" | "weekly" | "interval" | "one-time" | "advanced";

const KIND_LABEL: Record<Kind, { title: string; blurb: string }> = {
  briefing: { title: "Recurring briefing / report", blurb: "An agent writes a report on a schedule and delivers it." },
  "scheduled-workflow": { title: "Run a workflow on schedule", blurb: "Trigger an existing workflow on a cadence." },
  "health-check": { title: "Health check with alert", blurb: "Check system health and alert only on a problem." },
};

export function GuidedAutomationModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<"guided" | "advanced">("guided");
  const [kind, setKind] = useState<Kind>("briefing");
  const [title, setTitle] = useState("Morning Brief");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [time, setTime] = useState("08:00");
  const [timezone, setTimezone] = useState("UTC");
  const [weekday, setWeekday] = useState(1);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [advancedCron, setAdvancedCron] = useState("0 8 * * *");
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [task, setTask] = useState("Summarize what changed overnight and the top 3 things to focus on today.");
  const [targetWorkflowId, setTargetWorkflowId] = useState("");
  const [channel, setChannel] = useState("webchat");
  const [deliveryTarget, setDeliveryTarget] = useState("");
  const [retryOnFailure, setRetryOnFailure] = useState(true);
  const [allowOverlap, setAllowOverlap] = useState(false);
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; cron: string; cadence: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    fetch("/api/workflows")
      .then((r) => r.json())
      .then((j) => setWorkflows(Array.isArray(j.data) ? j.data.map((w: { id: string; name: string }) => ({ id: w.id, name: w.name })) : []))
      .catch(() => {});
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const def = {
        title,
        kind,
        cadence: mode === "advanced" ? "advanced" : cadence,
        time,
        timezone,
        weekday,
        intervalMinutes,
        advancedCron,
        date,
        task,
        targetWorkflowId,
        deliveryChannel: channel,
        deliveryTarget,
        retryOnFailure,
        allowOverlap,
      };
      const res = await fetch("/api/automations/guided", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(def),
      });
      const j = await res.json();
      if (!j.success) {
        setError(j.error || "Failed to create automation");
      } else {
        setResult({ name: j.data.name, cron: j.data.cron, cadence: j.data.cadence });
        onCreated();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create automation</DialogTitle>
        </DialogHeader>

        <div className="mb-3 flex gap-2">
          <Button size="sm" variant={mode === "guided" ? "default" : "outline"} onClick={() => setMode("guided")}>Guided</Button>
          <Button size="sm" variant={mode === "advanced" ? "default" : "outline"} onClick={() => setMode("advanced")}>Advanced</Button>
        </div>

        {result ? (
          <div className="space-y-2 text-sm">
            <Badge>Created</Badge>
            <p className="font-medium">{result.name}</p>
            <p className="text-muted-foreground">{result.cadence}</p>
            <p className="font-mono text-xs text-muted-foreground">cron: {result.cron}</p>
            <p className="text-xs text-muted-foreground">It now appears in the schedule list below. Use Run Now to test it.</p>
            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <Label>What should it do?</Label>
              <div className="mt-1 space-y-1">
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`block w-full rounded border p-2 text-left text-xs ${kind === k ? "border-primary" : "border-border"}`}
                  >
                    <span className="font-medium">{KIND_LABEL[k].title}</span>
                    <span className="ml-1 text-muted-foreground">— {KIND_LABEL[k].blurb}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            {kind === "briefing" && (
              <div>
                <Label>Task / prompt</Label>
                <Textarea rows={2} value={task} onChange={(e) => setTask(e.target.value)} />
              </div>
            )}
            {kind === "scheduled-workflow" && (
              <div>
                <Label>Workflow to run</Label>
                <select className="mt-1 w-full rounded border border-border bg-background p-2" value={targetWorkflowId} onChange={(e) => setTargetWorkflowId(e.target.value)}>
                  <option value="">Select a workflow…</option>
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
            )}

            {mode === "guided" ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>When</Label>
                  <select className="mt-1 w-full rounded border border-border bg-background p-2" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                    <option value="daily">Every day</option>
                    <option value="weekdays">Weekdays</option>
                    <option value="weekly">Weekly</option>
                    <option value="interval">Repeat interval</option>
                    <option value="one-time">One time</option>
                  </select>
                </div>
                {cadence === "interval" ? (
                  <div>
                    <Label>Repeat every</Label>
                    <select className="mt-1 w-full rounded border border-border bg-background p-2" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
                      <option value={5}>5 minutes</option>
                      <option value={15}>15 minutes</option>
                      <option value={30}>30 minutes</option>
                      <option value={60}>1 hour</option>
                      <option value={120}>2 hours</option>
                      <option value={360}>6 hours</option>
                      <option value={720}>12 hours</option>
                      <option value={1440}>24 hours</option>
                    </select>
                  </div>
                ) : (
                  <div>
                    <Label>Time</Label>
                    <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                  </div>
                )}
                {cadence === "weekly" && (
                  <div>
                    <Label>Day</Label>
                    <select className="mt-1 w-full rounded border border-border bg-background p-2" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                        <option key={d} value={i}>{d}</option>
                      ))}
                    </select>
                  </div>
                )}
                {cadence === "one-time" && (
                  <div>
                    <Label>Date</Label>
                    <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </div>
                )}
                <div>
                  <Label>Timezone</Label>
                  <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                </div>
              </div>
            ) : (
              <div>
                <Label>Cron expression (advanced)</Label>
                <Input value={advancedCron} onChange={(e) => setAdvancedCron(e.target.value)} placeholder="0 8 * * *" />
                <p className="mt-1 text-xs text-muted-foreground">Standard 5-field cron. Timezone: {timezone}.</p>
              </div>
            )}

            <div>
              <Label>Deliver to</Label>
              <select className="mt-1 w-full rounded border border-border bg-background p-2" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="webchat">WebChat</option>
                <option value="telegram">Telegram</option>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
              </select>
            </div>
            {channel !== "webchat" && (
              <div>
                <Label>{channel === "telegram" ? "Telegram chat ID" : channel === "slack" ? "Slack channel" : "Discord channel ID"}</Label>
                <Input
                  value={deliveryTarget}
                  onChange={(e) => setDeliveryTarget(e.target.value)}
                  placeholder={channel === "telegram" ? "123456789" : channel === "slack" ? "#general or C012..." : "channel id"}
                />
                <p className="mt-1 text-xs text-muted-foreground">The channel must already be connected in Channels.</p>
              </div>
            )}

            <div className="grid gap-2 rounded border border-border p-2 text-xs sm:grid-cols-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={retryOnFailure} onChange={(e) => setRetryOnFailure(e.target.checked)} />
                Retry once on failure
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
                Allow overlapping runs
              </label>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create automation"}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
