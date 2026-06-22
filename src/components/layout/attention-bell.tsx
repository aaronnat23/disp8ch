"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, X, AlertTriangle, CircleAlert, Info } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getDesktopBridge } from "@/lib/client/desktop-bridge";

type AttentionItem = {
  id: string;
  sourceType: string;
  sourceId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  href: string;
  action: { label: string; kind: string };
  createdAt: string;
};

type AttentionSummary = {
  items: AttentionItem[];
  counts: { total: number; critical: number; warn: number; info: number };
};

const POLL_MS = 20000;

function severityIcon(severity: AttentionItem["severity"]) {
  if (severity === "critical") return <CircleAlert className="h-3.5 w-3.5 text-terminal-red" />;
  if (severity === "warn") return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
  return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
}

export function AttentionBell() {
  const router = useRouter();
  const [summary, setSummary] = useState<AttentionSummary>({ items: [], counts: { total: 0, critical: 0, warn: 0, info: 0 } });
  const notifiedRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/attention", { cache: "no-store" });
      const json = await res.json();
      if (!json.success) return;
      const data = json.data as AttentionSummary;
      setSummary(data);

      const bridge = getDesktopBridge();
      if (bridge) {
        void bridge.setAttention({ count: data.counts.total, critical: data.counts.critical });
        for (const item of data.items) {
          if (notifiedRef.current.has(item.id)) continue;
          notifiedRef.current.add(item.id);
          void bridge.notify({
            id: item.id,
            title: item.title,
            body: item.detail,
            href: item.href,
            severity: item.severity,
          });
        }
      }
    } catch {
      /* ignore polling errors */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const dismiss = async (item: AttentionItem) => {
    setSummary((prev) => ({
      ...prev,
      items: prev.items.filter((i) => i.id !== item.id),
      counts: { ...prev.counts, total: Math.max(0, prev.counts.total - 1) },
    }));
    try {
      await fetch("/api/attention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", sourceType: item.sourceType, sourceId: item.sourceId }),
      });
    } catch {
      /* optimistic */
    }
  };

  const openItem = (item: AttentionItem) => {
    router.push(item.href);
  };

  const { total, critical } = summary.counts;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={total > 0 ? `${total} items need attention` : "Attention Center"}
          className="relative flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent transition-colors"
        >
          <Bell className="h-4 w-4 text-muted-foreground" />
          {total > 0 ? (
            <span
              className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white ${
                critical > 0 ? "bg-terminal-red" : "bg-amber-500"
              }`}
            >
              {total > 9 ? "9+" : total}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Attention Center</span>
          <span className="text-[10px] text-muted-foreground">{total} open</span>
        </div>
        <div className="max-h-96 overflow-auto">
          {summary.items.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing needs attention.</div>
          ) : (
            summary.items.map((item) => (
              <div key={item.id} className="group flex items-start gap-2 border-b px-3 py-2.5 last:border-0 hover:bg-muted/40">
                <div className="mt-0.5">{severityIcon(item.severity)}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{item.title}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openItem(item)}
                      className="rounded border px-2 py-0.5 text-[10px] font-medium hover:bg-accent"
                    >
                      {item.action.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => void dismiss(item)}
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => void dismiss(item)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              </div>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
