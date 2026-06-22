"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAfterUseful } from "@/lib/client/use-after-useful";

// Lazy-load the Monaco wrapper itself, not just its inner editor. This keeps the
// theme/event-listener bootstrap code out of the /files initial bundle until the
// user actually selects a file to view.
const MonacoEditor = dynamic(
  () => import("@/components/ui/monaco-editor").then((mod) => ({ default: mod.MonacoEditor })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center border border-border bg-muted/30">
        <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Loading editor…</span>
      </div>
    ),
  },
);
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  Save,
  RefreshCw,
  Lock,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type FileEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  ext?: string;
};

type TreeNode = FileEntry & {
  children?: TreeNode[];
  expanded?: boolean;
  loaded?: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function getFileIcon(entry: FileEntry) {
  if (entry.type === "dir") return null;
  return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

// ── Tree Item ─────────────────────────────────────────────────────────────────

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (node: TreeNode) => void;
  onToggle: (node: TreeNode) => void;
}) {
  const isSelected = node.path === selectedPath;
  const isDir = node.type === "dir";

  return (
    <div>
      <button
        onClick={() => (isDir ? onToggle(node) : onSelect(node))}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors",
          isSelected
            ? "bg-terminal-red/10 text-terminal-red border-l border-terminal-red"
            : "text-muted-foreground hover:bg-accent hover:text-foreground border-l border-transparent",
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {isDir ? (
          <>
            {node.expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            {node.expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-terminal-red/70" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
          </>
        ) : (
          <>
            <span className="h-3 w-3 shrink-0" />
            {getFileIcon(node)}
          </>
        )}
        <span className="truncate font-mono">{node.name}</span>
        {node.type === "file" && node.size !== undefined && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
            {fmtSize(node.size)}
          </span>
        )}
      </button>
      {isDir && node.expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function FilesPage() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [editorLanguage, setEditorLanguage] = useState("plaintext");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const saveOkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDirty = editorContent !== savedContent && !isReadOnly;

  // Load top-level roots after useful-ready so the file tree shell renders first.
  useAfterUseful(() => {
    void loadDir("", null);
  }, []);

  async function loadDir(path: string, parentNode: TreeNode | null) {
    const url = path
      ? `/api/files?action=list&path=${encodeURIComponent(path)}`
      : `/api/files?action=list`;
    const res = await fetch(url);
    const json = await res.json() as { success: boolean; data?: FileEntry[]; error?: string };
    if (!json.success || !json.data) return;

    const children: TreeNode[] = json.data.map((e) => ({ ...e, expanded: false, loaded: false, children: [] }));

    if (!parentNode) {
      setTree(children);
    } else {
      setTree((prev) => updateNodeInTree(prev, parentNode.path, (n) => ({
        ...n,
        children,
        loaded: true,
        expanded: true,
      })));
    }
  }

  function updateNodeInTree(nodes: TreeNode[], targetPath: string, updater: (n: TreeNode) => TreeNode): TreeNode[] {
    return nodes.map((n) => {
      if (n.path === targetPath) return updater(n);
      if (n.children) return { ...n, children: updateNodeInTree(n.children, targetPath, updater) };
      return n;
    });
  }

  const handleToggle = useCallback(async (node: TreeNode) => {
    if (node.expanded) {
      // Collapse
      setTree((prev) => updateNodeInTree(prev, node.path, (n) => ({ ...n, expanded: false })));
    } else if (!node.loaded) {
      await loadDir(node.path, node);
    } else {
      setTree((prev) => updateNodeInTree(prev, node.path, (n) => ({ ...n, expanded: true })));
    }
  }, []);

  const handleSelect = useCallback(async (node: TreeNode) => {
    if (isDirty) {
      const ok = window.confirm("You have unsaved changes. Discard and open new file?");
      if (!ok) return;
    }
    setLoading(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const res = await fetch(`/api/files?action=read&path=${encodeURIComponent(node.path)}`);
      const json = await res.json() as {
        success: boolean;
        data?: { content: string; language: string; readOnly: boolean; name: string };
        error?: string;
      };
      if (json.success && json.data) {
        setEditorContent(json.data.content);
        setSavedContent(json.data.content);
        setEditorLanguage(json.data.language);
        setIsReadOnly(json.data.readOnly);
        setSelectedPath(node.path);
        setSelectedName(json.data.name);
      }
    } finally {
      setLoading(false);
    }
  }, [isDirty]);

  const handleSave = useCallback(async () => {
    if (!selectedPath || isReadOnly) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const res = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write", path: selectedPath, content: editorContent }),
      });
      const json = await res.json() as { success: boolean; error?: string };
      if (json.success) {
        setSavedContent(editorContent);
        setSaveOk(true);
        if (saveOkTimer.current) clearTimeout(saveOkTimer.current);
        saveOkTimer.current = setTimeout(() => setSaveOk(false), 2000);
      } else {
        setSaveError(json.error ?? "Save failed");
      }
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }, [selectedPath, editorContent, isReadOnly]);

  // Cmd/Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && selectedPath && !isReadOnly) {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, selectedPath, isReadOnly]);

  return (
        <div className="flex flex-1 overflow-hidden" data-perf-ready="files">
          {/* ── File Tree ── */}
          <div className="flex w-[260px] shrink-0 flex-col border-r border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground font-mono">
                Workspace Files
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => {
                  setTree([]);
                  void loadDir("", null);
                }}
                title="Refresh"
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>
            <div className="flex-1 overflow-auto py-1 text-xs">
              {tree.length === 0 ? (
                <p className="px-3 py-4 text-center text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                  Loading...
                </p>
              ) : (
                tree.map((node) => (
                  <TreeItem
                    key={node.path}
                    node={node}
                    depth={0}
                    selectedPath={selectedPath}
                    onSelect={handleSelect}
                    onToggle={handleToggle}
                  />
                ))
              )}
            </div>
          </div>

          {/* ── Editor ── */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Editor header */}
            <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
              <div className="flex min-w-0 items-center gap-2">
                {selectedName ? (
                  <>
                    <FileText className="h-3.5 w-3.5 shrink-0 text-terminal-red" />
                    <span className="truncate text-xs font-mono font-medium">{selectedName}</span>
                    {isReadOnly && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-1">
                        <Lock className="h-2.5 w-2.5" /> READ-ONLY
                      </Badge>
                    )}
                    {isDirty && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-terminal-red/40 text-terminal-red">
                        UNSAVED
                      </Badge>
                    )}
                    {saveOk && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-foreground/30 text-foreground">
                        SAVED
                      </Badge>
                    )}
                  </>
                ) : (
                  <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                    Select a file to edit
                  </span>
                )}
              </div>
              {selectedPath && !isReadOnly && (
                <Button
                  size="sm"
                  variant={isDirty ? "default" : "outline"}
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => void handleSave()}
                  disabled={saving || !isDirty}
                  title="Save (Ctrl+S)"
                >
                  <Save className="h-3 w-3" />
                  {saving ? "Saving…" : "Save"}
                </Button>
              )}
            </div>

            {saveError && (
              <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {saveError}
              </div>
            )}

            {/* Monaco editor */}
            {selectedPath ? (
              loading ? (
                <div className="flex flex-1 items-center justify-center">
                  <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="flex-1 overflow-hidden">
                  <MonacoEditor
                    value={editorContent}
                    onChange={setEditorContent}
                    language={editorLanguage}
                    height="100%"
                    readOnly={isReadOnly}
                  />
                </div>
              )
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <FolderOpen className="h-10 w-10 text-muted-foreground/30" />
                <div className="text-center">
                  <p className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
                    Workspace File Editor
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground/60 font-mono">
                    Select a file from the tree to view or edit
                  </p>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] font-mono uppercase tracking-wider">
                  {[
                    { label: "workspace/", desc: "Agent files" },
                    { label: "logs/", desc: "Read-only" },
                    { label: "memories/", desc: "Read-only" },
                  ].map(({ label, desc }) => (
                    <div key={label} className="border border-border px-3 py-2 text-center">
                      <p className="font-semibold text-foreground">{label}</p>
                      <p className="text-muted-foreground">{desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
  );
}
