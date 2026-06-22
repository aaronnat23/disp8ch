"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  isCompletionNotificationsEnabled,
  notificationPermission,
  setCompletionNotificationsEnabled,
} from "@/lib/client/completion-notifications";

export function CompletionNotificationsToggle() {
  const [enabled, setEnabled] = useState(false);
  const [perm, setPerm] = useState<string>("default");

  useEffect(() => {
    setEnabled(isCompletionNotificationsEnabled());
    setPerm(notificationPermission());
  }, []);

  const toggle = async (next: boolean) => {
    const granted = await setCompletionNotificationsEnabled(next);
    setEnabled(granted && next);
    setPerm(notificationPermission());
  };

  return (
    <div className="flex items-center justify-between rounded border border-border p-3">
      <div>
        <Label className="text-sm">Completion notifications</Label>
        <p className="text-xs text-muted-foreground">
          Notify me when a long response or background task finishes while this tab is in the background.
          {perm === "denied" && " (Browser notifications are blocked — enable them in your browser settings.)"}
          {perm === "unsupported" && " (Not supported in this browser.)"}
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={(v) => void toggle(v)} disabled={perm === "unsupported" || perm === "denied"} />
    </div>
  );
}
