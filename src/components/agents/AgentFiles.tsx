"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AgentFile } from "./types";

export function AgentFiles({
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
}: {
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
}) {
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
                  disabled={savingFile || !selectedFileName}
                  onClick={() => setFileDraftContent(fileBaseContent)}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  disabled={savingFile || !selectedFileName}
                  onClick={onSaveFile}
                >
                  {savingFile ? "Saving..." : fileDirty ? "Save" : "Saved"}
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
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
