"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";

type PendingToolApproval = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  reasons: string[];
  channelSessionId?: string;
  expiresAtMs: number;
};

type Resolution = {
  id: string;
  status: string;
  ok: boolean;
  detail: string;
};

function approvalTarget(approval: PendingToolApproval): string {
  const target = String(approval.args.target || approval.args.app_hint || "").trim();
  if (target) return target;
  if (Array.isArray(approval.args.keys)) return approval.args.keys.map(String).join("+");
  if (typeof approval.args.text === "string" || typeof approval.args.value === "string") return "Text content hidden";
  return "Local desktop";
}

export function ToolApprovalCard({ sessionId }: { sessionId: string }) {
  const [items, setItems] = useState<PendingToolApproval[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/tool-approvals", { cache: "no-store" });
      const json = await response.json() as { success?: boolean; data?: PendingToolApproval[] };
      if (json.success) {
        setItems((json.data || []).filter((item) => item.channelSessionId === sessionId));
      }
    } catch {
      // The Approvals page remains the fallback when this optional inline view is unavailable.
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const resolve = async (approval: PendingToolApproval, decision: "approve" | "deny") => {
    setResolving(approval.id);
    try {
      const response = await fetch("/api/tool-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: approval.id, decision }),
      });
      const json = await response.json() as { success?: boolean; status?: string; result?: string; error?: string };
      setResolution({
        id: approval.id,
        status: json.status || (json.success ? decision : "error"),
        ok: Boolean(json.success),
        detail: String(json.result || json.error || (decision === "deny" ? "Action denied." : "Exact pending action executed.")).slice(0, 1_200),
      });
      await load();
    } finally {
      setResolving(null);
    }
  };

  if (items.length === 0 && !resolution) return null;

  return (
    <div className="mt-3 space-y-2">
      {items.map((approval) => (
        <div key={approval.id} className="rounded-md border border-amber-500/50 bg-background/70 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400" />
            <span className="font-medium">Approval required</span>
            <Badge variant="outline" className="font-mono text-[10px]">{approval.name}</Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Target: {approvalTarget(approval)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{approval.reasons.join(" ")}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="h-7" disabled={resolving === approval.id} onClick={() => void resolve(approval, "approve")}>
              Approve once
            </Button>
            <Button size="sm" variant="outline" className="h-7" disabled={resolving === approval.id} onClick={() => void resolve(approval, "deny")}>
              Deny
            </Button>
          </div>
        </div>
      ))}
      {resolution ? (
        <div className={`rounded-md border p-3 text-xs ${resolution.ok ? "border-emerald-500/40" : "border-red-500/40"}`}>
          <div className="flex items-center gap-2 font-medium">
            {resolution.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-red-400" />}
            {resolution.status.replaceAll("_", " ")}
          </div>
          <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{resolution.detail}</p>
        </div>
      ) : null}
    </div>
  );
}
