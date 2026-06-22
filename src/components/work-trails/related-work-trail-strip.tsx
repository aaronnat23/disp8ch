"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WorkTrailDrawer } from "@/components/work-trails/work-trail-drawer";
import { WebChatDraftButton } from "@/components/app/webchat-draft-button";
import { cn } from "@/lib/utils";

type WorkTrailSummary = {
  id: string;
  status: string;
  userMessage: string;
  path: string[];
  objectCount: number;
};

export function RelatedWorkTrailStrip({
  surface,
  objectType,
  objectId,
  objectName,
  className,
}: {
  surface: string;
  objectType: string;
  objectId?: string | null;
  objectName?: string | null;
  className?: string;
}) {
  const [trails, setTrails] = useState<WorkTrailSummary[]>([]);
  const [openTrailId, setOpenTrailId] = useState<string | null>(null);

  useEffect(() => {
    if (!objectId) {
      setTrails([]);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ surface, objectType, objectId });
    fetch(`/api/work-trails?${params.toString()}`)
      .then((response) => response.json())
      .then((json) => {
        if (cancelled) return;
        const next = Array.isArray(json?.data?.trails) ? json.data.trails : Array.isArray(json?.data) ? json.data : [];
        setTrails(next.slice(0, 3) as WorkTrailSummary[]);
      })
      .catch(() => {
        if (!cancelled) setTrails([]);
      });
    return () => { cancelled = true; };
  }, [surface, objectType, objectId]);

  const primaryTrail = trails[0];
  const summary = useMemo(() => {
    if (!primaryTrail) return "";
    return `Related trail: ${primaryTrail.path.join(" -> ")}${objectName ? ` for ${objectName}` : ""}`;
  }, [objectName, primaryTrail]);

  if (!objectId || !primaryTrail) return null;

  return (
    <>
      <div className={cn("rounded-md border border-border bg-card/50 px-3 py-2", className)}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate text-xs font-medium">{summary}</span>
              <Badge variant="outline" className="h-5 text-[10px] capitalize">{primaryTrail.status}</Badge>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{primaryTrail.userMessage}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setOpenTrailId(primaryTrail.id)}>
              <ExternalLink className="mr-1.5 h-3 w-3" />
              Open
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => void navigator.clipboard?.writeText(summary)}>
              <Copy className="mr-1.5 h-3 w-3" />
              Copy
            </Button>
            <WebChatDraftButton
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              label="Ask"
              draft={`Explain this related work trail and recommend the next safe action.\n\nTrail: ${primaryTrail.id}\nObject: ${surface}/${objectType}/${objectId}${objectName ? ` (${objectName})` : ""}`}
            />
          </div>
        </div>
      </div>
      <WorkTrailDrawer trailId={openTrailId} open={Boolean(openTrailId)} onOpenChange={(open) => { if (!open) setOpenTrailId(null); }} />
    </>
  );
}

