"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Compass, Lightbulb, MessageSquareText, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Suggestion = {
  id: string;
  title: string;
  description: string;
  reason: string;
  href: string;
  actionLabel: string;
  tags: string[];
};

const TIPS_KEY = "disp8ch-contextual-tips-enabled";
const DISMISSED_KEY = "disp8ch-contextual-tips-dismissed";

function readDismissed(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function CapabilityDiscovery() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tipsEnabled, setTipsEnabled] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState("");
  const requestRef = useRef<{ controller: AbortController; id: number } | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    setTipsEnabled(localStorage.getItem(TIPS_KEY) === "1");
    setDismissed(readDismissed());
    const listener = () => setOpen(true);
    window.addEventListener("disp8ch:discover-more", listener);
    return () => window.removeEventListener("disp8ch:discover-more", listener);
  }, []);

  useEffect(() => () => requestRef.current?.controller.abort(), []);

  const load = useCallback(async (intentOverride?: string) => {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    requestRef.current = { controller, id: requestId };
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ pathname, limit: "6" });
      const requestedIntent = intentOverride?.trim();
      if (requestedIntent) params.set("intent", requestedIntent);
      const response = await fetch(`/api/discovery?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const json = await response.json() as {
        success?: boolean;
        data?: { suggestions?: Suggestion[] };
        error?: string;
      };
      if (!response.ok || !json.success) {
        throw new Error(json.error || `Discovery failed (${response.status})`);
      }
      if (requestId === requestIdRef.current) {
        setSuggestions(Array.isArray(json.data?.suggestions) ? json.data.suggestions : []);
      }
    } catch (loadError) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Could not load suggestions.");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        requestRef.current = null;
      }
    }
  }, [pathname]);

  useEffect(() => {
    if (open || tipsEnabled) void load();
  }, [load, open, tipsEnabled]);

  const visible = useMemo(() => suggestions.filter((item) => !dismissed.has(item.id)), [dismissed, suggestions]);
  const tip = visible[0] ?? null;

  const setTips = (enabled: boolean) => {
    setTipsEnabled(enabled);
    localStorage.setItem(TIPS_KEY, enabled ? "1" : "0");
  };
  const dismiss = (id: string) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(next)));
  };
  const restoreDismissed = () => {
    setDismissed(new Set());
    localStorage.removeItem(DISMISSED_KEY);
  };
  const discussIntent = () => {
    const task = intent.trim() || `Help me discover which Disp8ch capabilities fit what I am doing on ${pathname}.`;
    const draft = `Look at my current Disp8ch setup and help me identify which existing commands, skills, tools, agents, or workflows best fit this goal: ${task}`;
    setOpen(false);
    router.push(`/chat?draft=${encodeURIComponent(draft)}`);
  };

  return (
    <>
      {tipsEnabled && tip && !open ? (
        <div className="flex min-h-10 flex-wrap items-center gap-2 border-b bg-primary/[0.04] px-3 py-2 text-xs sm:gap-3 sm:px-4">
          <Lightbulb className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground">{tip.title}</span>
            <span className="ml-2 text-muted-foreground">{tip.description}</span>
          </div>
          <Button size="sm" variant="ghost" className="h-10 shrink-0 transition-transform active:scale-[0.96]" onClick={() => router.push(tip.href)}>{tip.actionLabel}</Button>
          <button type="button" aria-label="Dismiss tip" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-[background-color,transform] hover:bg-muted active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => dismiss(tip.id)}><X className="h-4 w-4" /></button>
        </div>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-[min(92vw,440px)] gap-2 overflow-hidden rounded-2xl p-2 shadow-2xl shadow-black/20">
          <DialogHeader className="px-3 py-3 pr-12 text-left">
            <div className="flex gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10"><Compass className="h-5 w-5 text-primary" /></div>
              <div>
                <DialogTitle>Discover more</DialogTitle>
                <DialogDescription className="mt-1 text-xs">Relevant capabilities for this page and your current setup.</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="max-h-[62vh] space-y-2 overflow-auto p-1">
              <form
                className="mb-2 flex gap-2 rounded-xl bg-muted/25 p-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void load(intent);
                }}
              >
                <Input
                  value={intent}
                  onChange={(event) => setIntent(event.target.value)}
                  aria-label="Describe what you want to accomplish"
                  placeholder="What are you trying to do?"
                  className="h-10 bg-background"
                />
                <Button type="submit" size="sm" className="h-10 shrink-0 transition-transform active:scale-[0.96]" disabled={loading || !intent.trim()}>
                  Find fits
                </Button>
              </form>
              <Button type="button" variant="outline" className="mb-2 min-h-10 w-full justify-start gap-2 transition-transform active:scale-[0.96]" onClick={discussIntent}>
                <MessageSquareText className="h-4 w-4" />
                Discuss what fits with your agent
              </Button>
              {error ? (
                <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <p>{error}</p>
                  <Button type="button" size="sm" variant="outline" className="mt-2 h-10 transition-transform active:scale-[0.96]" onClick={() => void load(intent)}>
                    Try again
                  </Button>
                </div>
              ) : null}
              {loading && visible.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">Checking your setup…</p> : visible.map((item) => (
                <article key={item.id} className="rounded-xl bg-muted/35 p-3 shadow-[0_0_0_1px_oklch(1_0_0/0.06)] transition-[box-shadow,background-color] duration-150 hover:bg-muted/55 hover:shadow-[0_0_0_1px_oklch(1_0_0/0.11)]">
                  <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-medium">{item.title}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.description}</p></div><button type="button" aria-label={`Dismiss ${item.title}`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-[background-color,transform] hover:bg-background/60 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => dismiss(item.id)}><X className="h-3.5 w-3.5" /></button></div>
                  <p className="mt-2 text-[11px] text-primary/80">{item.reason}</p>
                  <div className="mt-3 flex items-center justify-between gap-2"><div className="flex flex-wrap gap-1">{item.tags.slice(0, 3).map((tag) => <Badge key={tag} variant="outline" className="text-[9px]">{tag}</Badge>)}</div><Button size="sm" className="h-10 transition-transform active:scale-[0.96]" onClick={() => { setOpen(false); router.push(item.href); }}>{item.actionLabel}</Button></div>
                </article>
              ))}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-1">
              <span>Contextual tip bar</span>
              {dismissed.size > 0 ? (
                <Button size="sm" variant="ghost" className="h-10 gap-1 px-2 transition-transform active:scale-[0.96]" onClick={restoreDismissed}>
                  <RotateCcw className="h-3.5 w-3.5" /> Reset hidden
                </Button>
              ) : null}
            </div>
            <Button size="sm" variant="outline" className="h-10 transition-transform active:scale-[0.96]" onClick={() => setTips(!tipsEnabled)}>{tipsEnabled ? "Turn off" : "Turn on"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
