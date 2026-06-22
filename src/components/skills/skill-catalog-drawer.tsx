"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  source: "bundled" | "optional";
  category: string;
  fileCount: number;
}
interface CatalogPreview extends CatalogEntry {
  instructions: string;
  files: Array<{ name: string; bytes: number }>;
  requestedTools: string[];
  securityFindings: Array<{ level: "warning" | "info"; message: string }>;
}

export function SkillCatalogDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/skills/catalog${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      const json = await res.json();
      if (json.success) setEntries(json.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load("");
      setPreview(null);
    }
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(query), 180);
    return () => window.clearTimeout(timer);
  }, [load, open, query]);

  const openPreview = useCallback(async (entry: CatalogEntry) => {
    const res = await fetch(`/api/skills/catalog?name=${encodeURIComponent(entry.name)}&source=${encodeURIComponent(entry.source)}`);
    const json = await res.json();
    if (json.success) setPreview(json.data);
  }, []);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Browse skills</DialogTitle>
        </DialogHeader>
        <div className="mb-3 flex gap-2">
          <Input
            placeholder="Search bundled + optional skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="grid max-h-[60vh] grid-cols-1 gap-3 md:grid-cols-2">
          <div className={`${preview ? "hidden md:block" : "block"} space-y-1 overflow-auto pr-2`}>
            {loading && <p className="text-xs text-muted-foreground">Loading...</p>}
            {!loading && entries.length === 0 && <p className="text-xs text-muted-foreground">No skills match.</p>}
            {entries.map((e) => (
              <button
                key={`${e.source}-${e.name}`}
                type="button"
                onClick={() => void openPreview(e)}
                className={`block w-full rounded border p-2 text-left text-xs ${preview?.name === e.name && preview.source === e.source ? "border-primary" : "border-border"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{e.title}</span>
                  <Badge variant="outline">{e.source}</Badge>
                </div>
                <p className="mt-0.5 line-clamp-2 text-muted-foreground">{e.description}</p>
              </button>
            ))}
          </div>
          <div className="overflow-auto rounded border border-border p-3 text-xs">
            {!preview ? (
              <p className="text-muted-foreground">Select a skill to preview it (no skill content is executed).</p>
            ) : (
              <div className="space-y-2">
                <Button size="sm" variant="ghost" className="h-7 px-2 md:hidden" onClick={() => setPreview(null)}>Back to skills</Button>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{preview.title}</span>
                  <Badge variant="outline">{preview.source}</Badge>
                </div>
                <p className="text-muted-foreground">{preview.description}</p>
                {preview.requestedTools.length > 0 && (
                  <div>
                    <span className="font-medium">Requested tools:</span>{" "}
                    {preview.requestedTools.map((t) => (
                      <Badge key={t} variant="secondary" className="mr-1">{t}</Badge>
                    ))}
                  </div>
                )}
                {preview.securityFindings.length > 0 && (
                  <div className="space-y-1">
                    {preview.securityFindings.map((f, i) => (
                      <div key={i} className={f.level === "warning" ? "text-amber-400" : "text-muted-foreground"}>
                        {f.level === "warning" ? "Warning: " : "Info: "}{f.message}
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <span className="font-medium">Files ({preview.files.length}):</span>
                  <ul className="mt-1 max-h-24 list-inside list-disc overflow-auto font-mono text-[11px] text-muted-foreground">
                    {preview.files.slice(0, 20).map((f) => (
                      <li key={f.name}>{f.name} ({f.bytes}b)</li>
                    ))}
                  </ul>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[11px]">{preview.instructions.slice(0, 1500)}</pre>
                <p className="text-[10px] text-muted-foreground">Bundled and optional skills are already local. Use the per-agent toggles to enable a skill for an agent. External packs install under “Advanced install”.</p>
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
