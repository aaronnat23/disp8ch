"use client";

import { useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AgentFile } from "./types";

export function AgentFiles({
  agentId,
  files,
  filesLoading,
  selectedFileName,
  setSelectedFileName,
  fileBaseContent,
  fileDraftContent,
  setFileDraftContent,
  fileDirty,
  savingFile,
  onSaveFile,
  onReloadFile,
  actionError,
  actionNotice,
}: {
  agentId: string;
  files: AgentFile[];
  filesLoading: boolean;
  selectedFileName: string | null;
  setSelectedFileName: (name: string | null) => void;
  fileBaseContent: string;
  fileDraftContent: string;
  setFileDraftContent: (content: string) => void;
  fileDirty: boolean;
  savingFile: boolean;
  onSaveFile: () => Promise<void>;
  onReloadFile: () => Promise<void>;
  actionError?: string | null;
  actionNotice?: string | null;
}) {
  const [confirmingSave, setConfirmingSave] = useState(false);
  const [revisions, setRevisions] = useState<Array<{ id: string; source: string; createdAt: string }>>([]);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  useEffect(() => setConfirmingSave(false), [selectedFileName, fileBaseContent]);
  const changeSummary = useMemo(() => {
    const before = fileBaseContent.split(/\r?\n/);
    const after = fileDraftContent.split(/\r?\n/);
    let changed = 0;
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      if (before[index] !== after[index]) changed += 1;
    }
    return { changed, before: before.length, after: after.length };
  }, [fileBaseContent, fileDraftContent]);

  const protectedProfile = Boolean(selectedFileName && ["SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md", "BOOT.md"].includes(selectedFileName));
  useEffect(() => {
    if (!protectedProfile || !selectedFileName) { setRevisions([]); setRevisionError(null); return; }
    const controller = new AbortController();
    setRevisionError(null);
    fetch(`/api/agents/files?agentId=${encodeURIComponent(agentId)}&name=${encodeURIComponent(selectedFileName)}&revisions=1`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) throw new Error(String(json.error || `Version history failed with HTTP ${response.status}`));
        return json;
      })
      .then((json) => setRevisions(Array.isArray(json.data?.revisions) ? json.data.revisions : []))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setRevisions([]);
        setRevisionError(error instanceof Error ? error.message : "Could not load version history");
      });
    return () => controller.abort();
  }, [agentId, fileBaseContent, protectedProfile, selectedFileName]);

  const rollback = async (revisionId: string) => {
    if (fileDirty) {
      setRollbackError("Save or reload the unsaved editor changes before restoring an earlier version.");
      return;
    }
    if (!window.confirm("Restore the content from before this revision? The current content will be saved as another recoverable revision.")) return;
    setRollingBackId(revisionId);
    setRollbackError(null);
    try {
      const expectedContentHash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(fileBaseContent),
      ).then((buffer) => Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join(""));
      const response = await fetch("/api/agents/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rollback", agentId, revisionId, expectedContentHash, confirmed: true }) });
      const json = await response.json();
      if (!json.success) throw new Error(String(json.error || `Restore failed with HTTP ${response.status}`));
      await onReloadFile();
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : String(error));
    } finally { setRollingBackId(null); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Workspace Files</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
          <div className="space-y-2">
            {filesLoading && files.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading files...</p>
            ) : files.length === 0 ? (
              <p className="text-sm text-muted-foreground">No files.</p>
            ) : (
              files.map((file) => (
                <button
                  key={file.name}
                  type="button"
                  className={`w-full rounded border px-2 py-2 text-left text-sm ${
                    selectedFileName === file.name ? "border-primary bg-muted/50" : "hover:bg-muted/30"
                  }`}
                  onClick={() => setSelectedFileName(file.name)}
                >
                  <div className="font-medium">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {file.missing ? "missing" : `${file.size ?? 0} bytes`}
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="font-medium text-sm">{selectedFileName || "Select a file"}</div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-10"
                  disabled={savingFile || !selectedFileName}
                  onClick={() => setFileDraftContent(fileBaseContent)}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  disabled={savingFile || !selectedFileName || !fileDirty}
                  onClick={() => protectedProfile ? setConfirmingSave(true) : void onSaveFile().catch(() => {})}
                  className="h-10 transition-transform duration-150 ease-out active:not-disabled:scale-[0.96]"
                >
                  {savingFile ? "Saving..." : fileDirty ? protectedProfile ? "Review save" : "Save" : "Saved"}
                </Button>
              </div>
            </div>
            <Textarea
              rows={20}
              value={fileDraftContent}
              onChange={(event) => setFileDraftContent(event.target.value)}
              placeholder={selectedFileName ? "File contents..." : "Select a file first"}
              disabled={!selectedFileName}
            />
            {confirmingSave && protectedProfile ? (
              <div className="rounded-lg bg-amber-500/10 p-3 shadow-[0_0_0_1px_oklch(0.75_0.15_75/0.28)]">
                <p className="text-sm font-medium">Confirm protected profile change</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {changeSummary.changed} line{changeSummary.changed === 1 ? "" : "s"} changed · {changeSummary.before} → {changeSummary.after} lines. A recoverable revision will be saved.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" className="h-10" onClick={() => setConfirmingSave(false)}>Cancel</Button>
                  <Button
                    size="sm"
                    disabled={savingFile}
                    onClick={() => void onSaveFile().then(() => setConfirmingSave(false)).catch(() => {})}
                    className="h-10 transition-transform duration-150 ease-out active:not-disabled:scale-[0.96]"
                  >
                    Confirm and save
                  </Button>
                </div>
              </div>
            ) : null}
            {actionError || rollbackError ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{rollbackError || actionError}</p>
            ) : revisionError ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{revisionError}</p>
            ) : actionNotice ? (
              <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{actionNotice}</p>
            ) : null}
            {protectedProfile && revisions.length > 0 ? (
              <details className="rounded-lg bg-muted/25 p-3 shadow-[0_0_0_1px_oklch(1_0_0/0.06)]">
                <summary className="flex min-h-10 cursor-pointer items-center text-xs font-medium">Version history ({revisions.length})</summary>
                {fileDirty ? (
                  <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">Save or reload the unsaved editor changes before restoring history.</p>
                ) : null}
                <div className="mt-2 space-y-1.5">
                  {revisions.slice(0, 8).map((revision) => (
                    <div key={revision.id} className="flex min-h-10 items-center justify-between gap-3 rounded-md bg-background/50 px-2 py-1.5 text-[11px]">
                      <span className="truncate text-muted-foreground">{new Date(revision.createdAt).toLocaleString()} · {revision.source}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-10 transition-transform duration-150 active:scale-[0.96]"
                        disabled={rollingBackId === revision.id || fileDirty}
                        title={fileDirty ? "Save or reload unsaved changes before restoring history" : "Restore this version"}
                        onClick={() => void rollback(revision.id)}
                      >
                        Restore
                      </Button>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
