"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Guided "Learn from sources" flow for the Skills tab. Builds an auditable source
 * pack from selected Documents, compiles a review-first skill candidate with
 * DeepSeek (the active provider), and shows deterministic verification before the
 * user installs it from the proposals review section. Never auto-installs.
 */

type DocumentItem = { id: string; name: string };

type VerifyResult = {
  passed: boolean;
  checks: string[];
  failures: string[];
  warnings: string[];
};

type CompileResponse = {
  candidateId: string | null;
  compileRunId: string;
  verification: VerifyResult;
  compiled: { skill_name: string; title: string; description: string; uncertainties: string[]; blocked_claims: string[] };
};

export default function LearnFromSources({ onCompiled }: { onCompiled?: () => void }) {
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompileResponse | null>(null);

  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch("/api/documents?limit=100");
      const json = (await res.json()) as { success: boolean; data?: DocumentItem[] };
      if (json.success) setDocuments((json.data ?? []).map((d) => ({ id: d.id, name: d.name })));
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (open) void loadDocuments();
  }, [open, loadDocuments]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const compile = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const docIds = Array.from(selected);
      if (docIds.length === 0) {
        setError("Select at least one source document.");
        return;
      }
      const packRes = await fetch("/api/source-packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "documents",
          name: name.trim() || "Learned skill sources",
          documentIds: docIds,
          createdBySurface: "skills",
        }),
      });
      const packJson = (await packRes.json()) as { success: boolean; data?: { pack: { id: string } }; error?: string };
      if (!packJson.success || !packJson.data) {
        setError(packJson.error || "Failed to build source pack");
        return;
      }
      const compileRes = await fetch("/api/learning/source-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "compile",
          sourcePackId: packJson.data.pack.id,
          instruction: instruction.trim() || undefined,
        }),
      });
      const compileJson = (await compileRes.json()) as { success: boolean; data?: CompileResponse; error?: string };
      if (!compileJson.success || !compileJson.data) {
        setError(compileJson.error || "Compilation failed");
        return;
      }
      setResult(compileJson.data);
      onCompiled?.();
    } finally {
      setBusy(false);
    }
  }, [selected, name, instruction, onCompiled]);

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)} className="text-xs uppercase tracking-wider">
          {open ? "Hide" : "Learn from sources"}
        </Button>
        <span className="text-xs text-muted-foreground">Compile uploaded documents into a reviewable skill.</span>
      </div>

      {open && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-widest text-muted-foreground">{"// Learn from sources"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Skill source set name (e.g. Acme API docs)"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Optional instruction: what should this skill help with?"
              rows={2}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
            <div className="max-h-48 overflow-y-auto rounded-md border border-border/60 p-2">
              {documents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No documents yet. Upload sources in the Documents tab first.</p>
              ) : (
                documents.map((doc) => (
                  <label key={doc.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input type="checkbox" checked={selected.has(doc.id)} onChange={() => toggle(doc.id)} />
                    <span className="truncate">{doc.name}</span>
                  </label>
                ))
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy || selected.size === 0} onClick={() => void compile()}>
                {busy ? "Compiling…" : "Compile skill candidate"}
              </Button>
              {selected.size > 0 && <Badge variant="outline" className="text-[10px]">{selected.size} selected</Badge>}
            </div>

            {error && <p className="text-xs text-red-400">{error}</p>}

            {result && (
              <div className="rounded-md border border-border/60 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={`text-[10px] ${result.verification.passed ? "text-green-400 border-green-500/40" : "text-red-400 border-red-500/40"}`}>
                    {result.verification.passed ? "verified" : "verification failed"}
                  </Badge>
                  <span className="font-medium">{result.compiled.title || result.compiled.skill_name}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{result.compiled.description}</p>
                {result.verification.failures.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-xs text-red-400">
                    {result.verification.failures.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
                {result.compiled.blocked_claims.length > 0 && (
                  <p className="mt-1 text-[11px] text-amber-400">
                    Blocked claims: {result.compiled.blocked_claims.join("; ")}
                  </p>
                )}
                {result.candidateId ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Candidate ready for review below. Inspect evidence and approve to install.
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">No candidate created — verification must pass first.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
