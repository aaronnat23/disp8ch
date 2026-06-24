"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Compact "Propose memory" action for source surfaces (Boards, Council,
 * notebooks). It pre-fills an evidence-linked candidate and lets the operator
 * edit the summary, type, tags, and scope before submission. It does NOT add a
 * navigation item or auto-create candidates — review/audit stays in the Memory
 * Explorer. Agent scope is shown explicitly and must be accepted by the operator.
 */
export default function ProposeMemoryButton(props: {
  originType: "board" | "council" | "notebook";
  originId?: string | null;
  documentId?: string | null;
  defaultContent: string;
  defaultType?: string;
  sourceSummary?: string;
  evidence?: string[];
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "default";
}) {
  const [openDialog, setOpenDialog] = useState(false);
  const [content, setContent] = useState(props.defaultContent);
  const [type, setType] = useState(props.defaultType || "fact");
  const [scopeKind, setScopeKind] = useState<"agent">("agent");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/memory/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          originType: props.originType,
          originId: props.originId ?? null,
          documentId: props.documentId ?? null,
          content,
          type,
          scopeKind,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          sourceSummary: props.sourceSummary ?? null,
          evidence: props.evidence ?? [],
        }),
      });
      const json = (await res.json()) as { success: boolean; created?: boolean; error?: string };
      setResult(json.success ? (json.created ? "Candidate created — review it in the Memory Explorer." : "A matching candidate already exists.") : json.error || "Failed");
      if (json.success) setTimeout(() => setOpenDialog(false), 1200);
    } catch (e) {
      setResult(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={openDialog} onOpenChange={setOpenDialog}>
      <DialogTrigger asChild>
        <Button size={props.size ?? "sm"} variant={props.variant ?? "outline"}>{props.label ?? "Propose memory"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Propose memory</DialogTitle>
          <DialogDescription>
            Create a reviewable, source-linked candidate. Nothing is saved to memory until you approve it in the Memory Explorer.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <textarea
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
            rows={4}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="What should be remembered?"
          />
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-2">
              Type
              <select className="rounded border border-border bg-background p-1" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="fact">Fact</option>
                <option value="preference">Preference</option>
                <option value="decision">Decision</option>
                <option value="observation">Observation</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              Scope
              <select className="rounded border border-border bg-background p-1" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as "agent")}>
                <option value="agent">This agent (shared)</option>
              </select>
            </label>
          </div>
          <input
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tags, comma, separated"
          />
          <p className="text-xs text-muted-foreground">
            This will be saved to <strong>this agent&apos;s</strong> shared memory after review. Workflow-private memory is created from inside a workflow, not here.
          </p>
          {result && <p className="text-xs text-muted-foreground">{result}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpenDialog(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={submitting || !content.trim()}>Create candidate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
