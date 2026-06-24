"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Candidate = {
  id: string;
  status: string;
  content: string;
  type: string;
  scopeKind: "workflow" | "agent";
  scopeId: string | null;
  originType: string;
  originId: string | null;
  executionId: string | null;
  sessionId: string | null;
  documentId: string | null;
  evidence: string[];
  sourceSummary: string | null;
  confidence: number;
  conflictState: "none" | "possible_duplicate" | "possible_conflict";
  relatedIds: string[];
  reviewAfter: string | null;
  expiresAt: string | null;
  appliedEntryId: string | null;
};

const ORIGIN_LINK: Record<string, (c: Candidate) => string | null> = {
  webchat: (c) => (c.sessionId ? `/chat?sessionId=${encodeURIComponent(c.sessionId)}` : null),
  workflow: (c) => (c.originId ? `/workflows/${encodeURIComponent(c.originId)}` : null),
  board: (c) => (c.originId ? `/boards?task=${encodeURIComponent(c.originId)}` : "/boards"),
  council: (c) => (c.originId ? `/council?session=${encodeURIComponent(c.originId)}` : "/council"),
  notebook: (c) => (c.originId ? `/documents?notebook=${encodeURIComponent(c.originId)}` : "/documents"),
};

const CONFLICT_TONE: Record<string, string> = {
  none: "",
  possible_duplicate: "border-yellow-500/40 text-yellow-400",
  possible_conflict: "border-red-500/40 text-red-400",
};

export default function MemoryCandidateReview() {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/memory/candidates?status=pending&limit=100");
      const json = (await res.json()) as { success: boolean; data?: Candidate[] };
      if (json.success) setCandidates(json.data ?? []);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const act = useCallback(async (id: string, body: Record<string, unknown>) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fetch("/api/memory/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      await load();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }, [load]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)} className="text-xs uppercase tracking-wider">
          {open ? "Hide" : "Show"} Review Candidates
        </Button>
        {candidates.length > 0 && (
          <Badge variant="outline" className="text-[10px]">{candidates.length} pending</Badge>
        )}
      </div>

      {open && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-widest text-muted-foreground">{"// Review Candidates"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No pending memory candidates. Candidates appear here when chat, a workflow, a Board task, a Council verdict, or a notebook proposes durable memory.
              </p>
            ) : (
              candidates.map((c) => {
                const link = ORIGIN_LINK[c.originType]?.(c) ?? null;
                return (
                  <div key={c.id} className="rounded-md border border-border/60 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{c.originType}</Badge>
                      <Badge variant="outline" className="text-[10px]">{c.scopeKind === "workflow" ? "This workflow" : "This agent"}</Badge>
                      <Badge variant="outline" className="text-[10px]">{c.type}</Badge>
                      {c.conflictState !== "none" && (
                        <Badge variant="outline" className={`text-[10px] ${CONFLICT_TONE[c.conflictState]}`}>
                          {c.conflictState === "possible_conflict" ? "possible conflict" : "possible duplicate"}
                        </Badge>
                      )}
                      {c.reviewAfter && <Badge variant="outline" className="text-[10px]">review due</Badge>}
                      {link && (
                        <a href={link} className="text-[10px] text-primary underline">source ↗</a>
                      )}
                    </div>
                    <div className="mt-2 whitespace-pre-wrap text-sm">{c.content}</div>
                    {c.sourceSummary && <div className="mt-1 text-xs text-muted-foreground">{c.sourceSummary}</div>}
                    {c.evidence.length > 0 && (
                      <div className="mt-1 text-[11px] text-muted-foreground font-mono">evidence: {c.evidence.slice(0, 3).join(" · ")}</div>
                    )}

                    {/* Exact write preview before applying. */}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">Write preview</summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-muted/40 p-2 text-[11px]">{JSON.stringify({ content: c.content, type: c.type, scope: c.scopeKind === "workflow" ? `workflow:${c.scopeId ?? ""}` : "agent" }, null, 2)}</pre>
                    </details>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {c.conflictState === "none" ? (
                        <Button size="sm" disabled={busy[c.id]} onClick={() => void act(c.id, { action: "apply", resolution: "keep_both" })}>Apply</Button>
                      ) : (
                        <>
                          {c.conflictState === "possible_duplicate" && c.relatedIds[0] && (
                            <Button size="sm" disabled={busy[c.id]} onClick={() => void act(c.id, { action: "apply", resolution: "reinforce_existing", targetMemoryId: c.relatedIds[0] })}>Reinforce existing</Button>
                          )}
                          <Button size="sm" variant="outline" disabled={busy[c.id]} onClick={() => void act(c.id, { action: "apply", resolution: "keep_both" })}>Keep both</Button>
                          {c.relatedIds[0] && (
                            <>
                              <Button size="sm" variant="outline" disabled={busy[c.id]} onClick={() => void act(c.id, { action: "apply", resolution: "replace_existing", targetMemoryId: c.relatedIds[0] })}>Replace existing</Button>
                              <Button size="sm" variant="outline" disabled={busy[c.id]} onClick={() => void act(c.id, { action: "apply", resolution: "mark_superseded", targetMemoryId: c.relatedIds[0] })}>Mark superseded</Button>
                            </>
                          )}
                        </>
                      )}
                      <Button size="sm" variant="outline" className="border-red-500/40 text-red-400 hover:bg-red-500/10" disabled={busy[c.id]} onClick={() => void act(c.id, { action: "reject" })}>Reject</Button>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
