"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WebChatDraftButton } from "@/components/app/webchat-draft-button";
import { MindMapView } from "@/components/notebooks/mind-map-view";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen, CheckCircle2, Circle, ChevronRight, ChevronDown, FilePlus2, Network, Search } from "lucide-react";

type DocumentItem = {
  id: string;
  sourceType: "upload" | "scrape" | "integration" | "folder";
  name: string;
  mimeType: string | null;
  sourceUrl: string | null;
  sizeBytes: number | null;
  excerpt: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

type DocumentDetail = {
  id: string;
  sourceType: "upload" | "scrape" | "integration" | "folder";
  name: string;
  mimeType: string | null;
  sourceUrl: string | null;
  sizeBytes: number | null;
  extractedText: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

type NotebookItem = {
  id: string;
  name: string;
  description: string | null;
  documentCount?: number;
  noteCount?: number;
  updatedAt: string;
};

type NotebookBundle = {
  notebook: NotebookItem;
  documents: Array<{ documentId: string; documentName: string; contextMode: "off" | "summary" | "full" }>;
  notes: Array<{ id: string; title: string; contentMd: string; origin: string; updatedAt: string }>;
  outputs: Array<{ id: string; type: string; title: string; payload: Record<string, unknown>; updatedAt: string }>;
  transformations: Array<{ id: string; name: string; prompt: string; builtIn: boolean }>;
};

const DOCUMENTS_UI_STATE_KEY = "disp8ch:documents-ui-state";

function formatSize(size: number | null): string {
  if (!size || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function toDocumentItem(detail: DocumentDetail): DocumentItem {
  return {
    id: detail.id,
    sourceType: detail.sourceType,
    name: detail.name,
    mimeType: detail.mimeType,
    sourceUrl: detail.sourceUrl,
    sizeBytes: detail.sizeBytes,
    excerpt: detail.extractedText.slice(0, 260),
    createdAt: detail.createdAt,
    metadata: detail.metadata,
  };
}

function DocumentsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [scrapeName, setScrapeName] = useState("");
  const [scrapeMode, setScrapeMode] = useState<"single" | "crawl">("single");
  const [scrapeStrategy, setScrapeStrategy] = useState<"auto" | "static" | "dynamic">("auto");
  const [crawlMaxPages, setCrawlMaxPages] = useState("20");
  const [crawlMaxDepth, setCrawlMaxDepth] = useState("2");
  const [crawlSameDomainOnly, setCrawlSameDomainOnly] = useState(true);
  const [crawlIncludeSubdomains, setCrawlIncludeSubdomains] = useState(true);
  const [crawlSeedFromSitemaps, setCrawlSeedFromSitemaps] = useState(true);
  const [crawlDelayMs, setCrawlDelayMs] = useState("120");
  const [crawlIncludePatterns, setCrawlIncludePatterns] = useState("");
  const [crawlExcludePatterns, setCrawlExcludePatterns] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<DocumentDetail | null>(null);
  const [message, setMessage] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<DocumentItem | DocumentDetail | null>(null);
  const [deletingDocument, setDeletingDocument] = useState(false);
  const [googleMode, setGoogleMode] = useState<"gmail" | "drive">("gmail");
  const [googleQuery, setGoogleQuery] = useState("");
  const [googleMaxResults, setGoogleMaxResults] = useState("5");
  const [importingGoogle, setImportingGoogle] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [folderRecursive, setFolderRecursive] = useState(true);
  const [folderMaxFiles, setFolderMaxFiles] = useState("500");
  const [importingFolder, setImportingFolder] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [view, setView] = useState<"library" | "notebooks">("library");
  const [notebooks, setNotebooks] = useState<NotebookItem[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [notebookBundle, setNotebookBundle] = useState<NotebookBundle | null>(null);
  const [newNotebookName, setNewNotebookName] = useState("");
  const [notebookQuestion, setNotebookQuestion] = useState("");
  const [notebookAnswer, setNotebookAnswer] = useState("");
  const [notebookBusy, setNotebookBusy] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [showExamples, setShowExamples] = useState(false);
  const [uploadedSource, setUploadedSource] = useState(false);
  const [lifecycleStep, setLifecycleStep] = useState(0);
  const lifecycleTimerRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const requestedDocumentId = useMemo(
    () => String(searchParams.get("documentId") || "").trim(),
    [searchParams],
  );

  const loadDocs = async (search = "") => {
    setLoading(true);
    try {
      const qs = search ? `?q=${encodeURIComponent(search)}` : "";
      const res = await fetch(`/api/documents${qs}`);
      const json = await res.json();
      if (json.success) {
        setDocs((json.data ?? []) as DocumentItem[]);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadNotebooks = async () => {
    const res = await fetch("/api/notebooks");
    const json = await res.json();
    if (json.success) {
      const rows = (json.data ?? []) as NotebookItem[];
      setNotebooks(rows);
      if (!selectedNotebookId && rows[0]) setSelectedNotebookId(rows[0].id);
    }
  };

  const loadNotebookBundle = async (id: string) => {
    const res = await fetch(`/api/notebooks/${encodeURIComponent(id)}`);
    const json = await res.json();
    if (json.success) setNotebookBundle(json.data as NotebookBundle);
  };

  const loadDetail = async (id: string) => {
    const res = await fetch(`/api/documents/${id}`);
    const json = await res.json();
    if (json.success) {
      setSelected(json.data as DocumentDetail);
    }
  };

  useEffect(() => {
    void loadDocs();
    void loadNotebooks();
  }, []);

  useEffect(() => {
    if (!selectedNotebookId) {
      setNotebookBundle(null);
      return;
    }
    void loadNotebookBundle(selectedNotebookId);
  }, [selectedNotebookId]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DOCUMENTS_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DOCUMENTS_UI_STATE_KEY,
        JSON.stringify({ hideGettingStarted }),
      );
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!requestedDocumentId) return;
    if (selectedId === requestedDocumentId) return;

    if (docs.some((doc) => doc.id === requestedDocumentId)) {
      setSelectedId(requestedDocumentId);
      return;
    }

    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/documents/${encodeURIComponent(requestedDocumentId)}`);
      const json = await res.json();
      if (!json.success || !json.data || cancelled) return;
      const detail = json.data as DocumentDetail;
      setDocs((current) => (
        current.some((doc) => doc.id === detail.id)
          ? current
          : [toDocumentItem(detail), ...current]
      ));
      setSelected(detail);
      setSelectedId(detail.id);
    })();

    return () => {
      cancelled = true;
    };
  }, [docs, requestedDocumentId, selectedId]);

  const startLifecycle = useCallback(() => {
    for (const timer of lifecycleTimerRef.current) clearTimeout(timer);
    lifecycleTimerRef.current = [];
    setUploadedSource(true);
    setLifecycleStep(0);
    lifecycleTimerRef.current = [
      setTimeout(() => setLifecycleStep(1), 800),
      setTimeout(() => setLifecycleStep(2), 1600),
      setTimeout(() => setLifecycleStep(3), 2400),
    ];
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of lifecycleTimerRef.current) clearTimeout(timer);
      lifecycleTimerRef.current = [];
    };
  }, []);

  const onUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setMessage("");
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result || "");
          const base64Part = raw.includes(",") ? raw.split(",").pop() || "" : raw;
          resolve(base64Part);
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(selectedFile);
      });

      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upload",
          fileName: selectedFile.name,
          mimeType: selectedFile.type || "application/octet-stream",
          contentBase64,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setMessage(`Upload failed: ${json.error || "unknown error"}`);
        return;
      }
      setMessage(`Uploaded ${selectedFile.name}`);
      setSelectedFile(null);
      startLifecycle();
      const input = document.getElementById("doc-upload-input") as HTMLInputElement | null;
      if (input) input.value = "";
      await loadDocs(query.trim());
      if (json.data?.id) {
        setSelectedId(json.data.id as string);
      }
    } finally {
      setUploading(false);
    }
  };

  const onScrape = async () => {
    if (!scrapeUrl.trim()) return;
    setScraping(true);
    setMessage("");
    try {
      const toArray = (raw: string) =>
        raw
          .split(/\r?\n|,/g)
          .map((value) => value.trim())
          .filter(Boolean);

      const payload: Record<string, unknown> = {
        action: "scrape",
        url: scrapeUrl.trim(),
        name: scrapeName.trim() || undefined,
        mode: scrapeMode,
        strategy: scrapeStrategy,
      };

      if (scrapeMode === "crawl") {
        payload.maxPages = Number(crawlMaxPages || "12");
        payload.maxDepth = Number(crawlMaxDepth || "1");
        payload.sameDomainOnly = crawlSameDomainOnly;
        payload.includeSubdomains = crawlIncludeSubdomains;
        payload.seedFromSitemaps = crawlSeedFromSitemaps;
        payload.requestDelayMs = Number(crawlDelayMs || "120");
        payload.includePatterns = toArray(crawlIncludePatterns);
        payload.excludePatterns = toArray(crawlExcludePatterns);
      }

      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) {
        setMessage(`Scrape failed: ${json.error || "unknown error"}`);
        return;
      }
      setMessage(scrapeMode === "crawl" ? `Deep-crawled ${scrapeUrl.trim()}` : `Scraped ${scrapeUrl.trim()}`);
      setScrapeUrl("");
      setScrapeName("");
      startLifecycle();
      await loadDocs(query.trim());
      if (json.data?.id) {
        setSelectedId(json.data.id as string);
      }
    } finally {
      setScraping(false);
    }
  };

  const onImportFolder = async () => {
    if (!folderPath.trim()) return;
    setImportingFolder(true);
    setMessage("");
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import-folder",
          path: folderPath.trim(),
          recursive: folderRecursive,
          maxFiles: Number(folderMaxFiles || "500"),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setMessage(`Folder import failed: ${json.error || "unknown error"}`);
        return;
      }
      const imported = Number(json.data?.imported || 0);
      const skipped = Number(json.data?.skipped || 0);
      setMessage(`Imported ${imported} markdown files${skipped ? ` (${skipped} skipped)` : ""}.`);
      startLifecycle();
      await loadDocs(query.trim());
      const firstId = Array.isArray(json.data?.ids) ? json.data.ids[0] : null;
      if (firstId) setSelectedId(String(firstId));
    } finally {
      setImportingFolder(false);
    }
  };

  const onDelete = async (id: string) => {
    setDeletingDocument(true);
    const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.success) {
      setMessage(`Delete failed: ${json.error || "unknown error"}`);
      setDeletingDocument(false);
      return;
    }

    if (selectedId === id) {
      setSelectedId(null);
      setSelected(null);
    }
    await loadDocs(query.trim());
    setMessage("Data source deleted.");
    setDeleteTarget(null);
    setDeletingDocument(false);
  };

  const onImportGoogle = async () => {
    setImportingGoogle(true);
    setMessage("");
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "google-workspace",
          modeType: googleMode,
          query: googleQuery.trim() || undefined,
          maxResults: Number(googleMaxResults || "5"),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setMessage(`Google Workspace import failed: ${json.error || "unknown error"}`);
        return;
      }
      setMessage(`Imported ${googleMode === "gmail" ? "Gmail" : "Drive"} snapshot`);
      startLifecycle();
      await loadDocs(query.trim());
      if (json.data?.id) {
        setSelectedId(json.data.id as string);
      }
    } finally {
      setImportingGoogle(false);
    }
  };

  const createNotebookFromName = async () => {
    const name = newNotebookName.trim();
    if (!name) return;
    setNotebookBusy(true);
    try {
      const res = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (json.success) {
        setNewNotebookName("");
        await loadNotebooks();
        setSelectedNotebookId(json.data.id as string);
      }
    } finally {
      setNotebookBusy(false);
    }
  };

  const addSelectedDocumentToNotebook = async (
    documentId: string,
    contextMode: "off" | "summary" | "full" = "summary",
  ) => {
    if (!selectedNotebookId) return;
    setNotebookBusy(true);
    try {
      await fetch(`/api/notebooks/${encodeURIComponent(selectedNotebookId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add-document", documentId, contextMode }),
      });
      await loadNotebookBundle(selectedNotebookId);
      await loadNotebooks();
    } finally {
      setNotebookBusy(false);
    }
  };

  const askNotebookQuestion = async () => {
    if (!selectedNotebookId || !notebookQuestion.trim()) return;
    setNotebookBusy(true);
    setNotebookAnswer("");
    try {
      const res = await fetch(`/api/notebooks/${encodeURIComponent(selectedNotebookId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ask", query: notebookQuestion.trim() }),
      });
      const json = await res.json();
      setNotebookAnswer(json.success ? String(json.data.answerMd || "") : String(json.error || "Ask failed"));
    } finally {
      setNotebookBusy(false);
    }
  };

  const saveNotebookNote = async () => {
    if (!selectedNotebookId || !noteDraft.trim()) return;
    setNotebookBusy(true);
    try {
      await fetch(`/api/notebooks/${encodeURIComponent(selectedNotebookId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "note", title: "Notebook note", contentMd: noteDraft.trim() }),
      });
      setNoteDraft("");
      await loadNotebookBundle(selectedNotebookId);
      await loadNotebooks();
    } finally {
      setNotebookBusy(false);
    }
  };

  const runNotebookAction = async (
    action: "transform" | "mind_map" | "timeline" | "audio_script",
    documentId?: string,
    transformationId?: string,
  ) => {
    if (!selectedNotebookId) return;
    setNotebookBusy(true);
    try {
      await fetch(`/api/notebooks/${encodeURIComponent(selectedNotebookId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "transform"
            ? { action: "transform", documentId, transformationId }
            : { action: "output", type: action, query: notebookQuestion.trim() || "overview" },
        ),
      });
      await loadNotebookBundle(selectedNotebookId);
    } finally {
      setNotebookBusy(false);
    }
  };

  const totalDocs = docs.length;

  const sortedDocs = useMemo(() => {
    return [...docs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [docs]);

  const selectedWarnings = useMemo(
    () =>
      Array.isArray(selected?.metadata?.safetyWarnings)
        ? (selected?.metadata?.safetyWarnings as Array<Record<string, unknown>>)
        : [],
    [selected],
  );

  const selectedPages = useMemo(
    () =>
      Array.isArray(selected?.metadata?.pages)
        ? (selected?.metadata?.pages as Array<Record<string, unknown>>)
        : [],
    [selected],
  );

  const selectedErrors = useMemo(
    () =>
      Array.isArray(selected?.metadata?.errors)
        ? (selected?.metadata?.errors as Array<Record<string, unknown>>)
        : [],
    [selected],
  );
  const selectedQualityIndicators = useMemo(() => {
    if (!selected) return [];
    const textLength = selected.extractedText.length;
    const pagesCrawled = Number(selected.metadata?.pagesCrawled || 0);
    const warningCount = Number(selected.metadata?.warningCount || 0);
    const duplicateSignals = Number(selected.metadata?.duplicateCount || selected.metadata?.duplicates || 0);
    const indexedAt = String(selected.metadata?.indexedAt || selected.metadata?.lastIndexedAt || selected.createdAt || "");
    return [
      { label: "Extracted Text", value: `${textLength.toLocaleString()} chars` },
      { label: "Pages Crawled", value: pagesCrawled > 0 ? String(pagesCrawled) : selected.sourceType === "scrape" ? "1" : "-" },
      { label: "Warnings", value: String(warningCount) },
      { label: "Duplicate Likelihood", value: duplicateSignals > 0 ? "possible" : "low" },
      { label: "Last Indexed", value: indexedAt ? new Date(indexedAt).toLocaleString() : "not recorded" },
    ];
  }, [selected]);

  const selectedNotebookDocumentIds = useMemo(
    () => new Set((notebookBundle?.documents ?? []).map((doc) => doc.documentId)),
    [notebookBundle],
  );

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="documents">
          <div className="mb-6 flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Data Sources</h1>
              <p className="text-sm text-muted-foreground">
                Manage source material here. Ask and reason over it from WebChat.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="rounded-md border p-1">
                <Button size="sm" variant={view === "library" ? "default" : "ghost"} onClick={() => setView("library")}>
                  Library
                </Button>
                <Button size="sm" variant={view === "notebooks" ? "default" : "ghost"} onClick={() => setView("notebooks")}>
                  <BookOpen className="mr-1 h-4 w-4" /> Notebooks
                </Button>
              </div>
              <Badge variant="outline">{totalDocs} stored</Badge>
            </div>
          </div>

          {view === "notebooks" ? (
            <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_360px]">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Notebooks</CardTitle>
                  <CardDescription>Group library sources without copying them.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      value={newNotebookName}
                      onChange={(event) => setNewNotebookName(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && void createNotebookFromName()}
                      placeholder="New notebook"
                    />
                    <Button size="icon" onClick={() => void createNotebookFromName()} disabled={notebookBusy || !newNotebookName.trim()} title="Create notebook">
                      <FilePlus2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {notebooks.length === 0 ? (
                      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No notebooks yet.</p>
                    ) : notebooks.map((notebook) => (
                      <button
                        key={notebook.id}
                        type="button"
                        className={`w-full rounded-md border p-3 text-left ${selectedNotebookId === notebook.id ? "border-primary" : "border-border"}`}
                        onClick={() => setSelectedNotebookId(notebook.id)}
                      >
                        <div className="text-sm font-semibold">{notebook.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {notebook.documentCount ?? 0} source{notebook.documentCount === 1 ? "" : "s"} • {notebook.noteCount ?? 0} note{notebook.noteCount === 1 ? "" : "s"}
                        </div>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{notebookBundle?.notebook.name || "Notebook"}</CardTitle>
                    <CardDescription>Manage sources, context modes, notes, and generated outputs. Use WebChat for real analysis.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="rounded-md border p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          <Search className="h-4 w-4" /> Preview citations
                        </div>
                        {selectedNotebookId ? (
                          <WebChatDraftButton
                            draft={`Use notebook "${notebookBundle?.notebook.name || "selected notebook"}" (id: ${selectedNotebookId}) and answer this from its enabled sources with citations: ${notebookQuestion || "<type your question here>"}`}
                            label="Ask in WebChat"
                            variant="secondary"
                          />
                        ) : null}
                      </div>
                      <p className="mb-2 text-xs text-muted-foreground">
                        This preview checks retrieval. Use WebChat when you want synthesis, follow-up reasoning, or actions.
                      </p>
                      <div className="flex gap-2">
                        <Input
                          value={notebookQuestion}
                          onChange={(event) => setNotebookQuestion(event.target.value)}
                          onKeyDown={(event) => event.key === "Enter" && void askNotebookQuestion()}
                          placeholder="Preview which notebook sources match a question"
                        />
                        <Button onClick={() => void askNotebookQuestion()} disabled={notebookBusy || !selectedNotebookId || !notebookQuestion.trim()}>
                          Preview
                        </Button>
                      </div>
                      {notebookAnswer ? (
                        <pre className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{notebookAnswer}</pre>
                      ) : null}
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <Button variant="outline" onClick={() => void runNotebookAction("mind_map")} disabled={!selectedNotebookId || notebookBusy}>
                        <Network className="mr-2 h-4 w-4" /> Mind Map
                      </Button>
                      <Button variant="outline" onClick={() => void runNotebookAction("timeline")} disabled={!selectedNotebookId || notebookBusy}>
                        Timeline
                      </Button>
                      <Button variant="outline" onClick={() => void runNotebookAction("audio_script")} disabled={!selectedNotebookId || notebookBusy}>
                        Audio Script
                      </Button>
                    </div>

                    <div>
                      <div className="mb-2 text-sm font-semibold">Notebook Sources</div>
                      <div className="space-y-2">
                        {(notebookBundle?.documents ?? []).length === 0 ? (
                          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Add sources from the Library Sources column.</p>
                        ) : notebookBundle!.documents.map((doc) => (
                          <div key={doc.documentId} className="flex items-center justify-between gap-2 rounded-md border p-3">
                            <div>
                              <div className="text-sm font-medium">{doc.documentName}</div>
                              <div className="text-xs text-muted-foreground">Context: {doc.contextMode}</div>
                            </div>
                            <div className="flex gap-1">
                              {(["off", "summary", "full"] as const).map((mode) => (
                                <Button
                                  key={mode}
                                  size="sm"
                                  variant={doc.contextMode === mode ? "default" : "outline"}
                                  onClick={() => void addSelectedDocumentToNotebook(doc.documentId, mode)}
                                  disabled={notebookBusy}
                                >
                                  {mode}
                                </Button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Notes & Outputs</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Textarea rows={3} placeholder="Write a notebook note" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} />
                    <Button size="sm" onClick={() => void saveNotebookNote()} disabled={!noteDraft.trim() || notebookBusy}>Save Note</Button>
                    <div className="grid gap-2 md:grid-cols-2">
                      {(notebookBundle?.notes ?? []).slice(0, 6).map((note) => (
                        <div key={note.id} className="rounded-md border p-3">
                          <div className="text-sm font-semibold">{note.title}</div>
                          <p className="mt-1 line-clamp-4 text-xs text-muted-foreground">{note.contentMd}</p>
                        </div>
                      ))}
                      {(notebookBundle?.outputs ?? []).slice(0, 6).map((output) => (
                        <div key={output.id} className={output.type === "mind_map" ? "border p-3 md:col-span-2" : "border p-3"}>
                          <div className="text-sm font-semibold">{output.title}</div>
                          <Badge variant="secondary" className="mt-1">{output.type}</Badge>
                          {output.type === "mind_map" ? (
                            <div className="mt-3">
                              <MindMapView title={output.title} payload={output.payload} />
                            </div>
                          ) : (
                            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(output.payload, null, 2)}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Library Sources</CardTitle>
                  <CardDescription>Add sources to the current notebook.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {sortedDocs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No library sources yet.</p>
                  ) : sortedDocs.map((doc) => (
                    <div key={doc.id} className="rounded-md border p-3">
                          <div className="text-sm font-semibold">{doc.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{doc.sourceType} • {doc.excerpt.slice(0, 120)}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={selectedNotebookDocumentIds.has(doc.id) ? "secondary" : "outline"}
                          onClick={() => void addSelectedDocumentToNotebook(doc.id, "summary")}
                          disabled={!selectedNotebookId || notebookBusy}
                        >
                          {selectedNotebookDocumentIds.has(doc.id) ? "Added" : "Add"}
                        </Button>
                        <WebChatDraftButton
                          draft={`Search the stored data source "${doc.name}" (id: ${doc.id}) and answer my question with citations: <type your question here>`}
                          label="Ask WebChat"
                          variant="ghost"
                        />
                        {selectedNotebookDocumentIds.has(doc.id) && notebookBundle?.transformations?.[0] ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void runNotebookAction("transform", doc.id, notebookBundle.transformations[0].id)}
                            disabled={notebookBusy}
                          >
                            Summary
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          ) : (
          <>

          <div className="mb-4 grid gap-4 lg:grid-cols-[460px_minmax(0,1fr)]">
            <Card>
              <CardContent className="pt-5 space-y-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">Add Data Source</h3>
                </div>
                <Tabs defaultValue="upload">
                  <TabsList className="grid w-full grid-cols-4">
                    <TabsTrigger value="upload">Local Files</TabsTrigger>
                    <TabsTrigger value="folder">Folder</TabsTrigger>
                    <TabsTrigger value="scrape">Web</TabsTrigger>
                    <TabsTrigger value="connected">Connected</TabsTrigger>
                  </TabsList>

                  <TabsContent value="upload" className="mt-4 space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="doc-upload-input">File</Label>
                      <Input
                        id="doc-upload-input"
                        type="file"
                        accept=".pdf,.docx,.pptx,.txt,.md,.html"
                        onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Supported: PDF, DOCX, PPTX, TXT, Markdown, HTML.
                      </p>
                    </div>
                    <Button onClick={onUpload} disabled={uploading || !selectedFile}>
                      {uploading ? "Uploading..." : "Upload File"}
                    </Button>
                  </TabsContent>

                  <TabsContent value="folder" className="mt-4 space-y-3">
                    <div className="space-y-2">
                      <Label>Folder Path</Label>
                      <Input
                        placeholder="C:\\Users\\User\\Documents\\Vault or /home/user/vault"
                        value={folderPath}
                        onChange={(event) => setFolderPath(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Imports Markdown and Obsidian-style notes as Data Sources. Re-importing updates matching files.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Max Files</Label>
                        <Input
                          value={folderMaxFiles}
                          onChange={(event) => setFolderMaxFiles(event.target.value)}
                          placeholder="500"
                        />
                      </div>
                      <label className="flex items-end gap-2 pb-2 text-xs">
                        <input
                          type="checkbox"
                          checked={folderRecursive}
                          onChange={(event) => setFolderRecursive(event.target.checked)}
                        />
                        Recursive
                      </label>
                    </div>
                    <Button onClick={onImportFolder} disabled={importingFolder || !folderPath.trim()}>
                      {importingFolder ? "Importing..." : "Import Folder"}
                    </Button>
                  </TabsContent>

                  <TabsContent value="scrape" className="mt-4 space-y-3">
                    <div className="space-y-2">
                      <Label>Mode</Label>
                      <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={scrapeMode}
                        onChange={(event) => setScrapeMode(event.target.value as "single" | "crawl")}
                      >
                        <option value="single">Single Page</option>
                        <option value="crawl">Deep Crawl</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>Strategy</Label>
                      <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={scrapeStrategy}
                        onChange={(event) => setScrapeStrategy(event.target.value as "auto" | "static" | "dynamic")}
                      >
                        <option value="auto">Auto Detect (recommended)</option>
                        <option value="static">Static HTTP (fast)</option>
                        <option value="dynamic">Dynamic Browser (JS rendered)</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Auto mode starts with static fetch and upgrades to browser-rendered crawl when needed. Deep crawl defaults are tuned for multi-page docs and public profile sites.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>URL</Label>
                      <Input
                        placeholder="https://example.com/article"
                        value={scrapeUrl}
                        onChange={(event) => setScrapeUrl(event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Name (optional)</Label>
                      <Input
                        placeholder={scrapeMode === "crawl" ? "Competitor intelligence crawl" : "Quarterly market report"}
                        value={scrapeName}
                        onChange={(event) => setScrapeName(event.target.value)}
                      />
                    </div>
                    {scrapeMode === "crawl" && (
                      <div className="rounded-md border p-3">
                        <div className="mb-2 text-xs font-semibold">Deep Crawl Settings</div>
                        <div className="grid gap-3 md:grid-cols-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Max Pages</Label>
                            <Input
                              value={crawlMaxPages}
                              onChange={(event) => setCrawlMaxPages(event.target.value)}
                              placeholder="20"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Max Depth</Label>
                            <Input
                              value={crawlMaxDepth}
                              onChange={(event) => setCrawlMaxDepth(event.target.value)}
                              placeholder="2"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Delay (ms)</Label>
                            <Input
                              value={crawlDelayMs}
                              onChange={(event) => setCrawlDelayMs(event.target.value)}
                              placeholder="120"
                            />
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-4 text-xs">
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={crawlSameDomainOnly}
                              onChange={(event) => setCrawlSameDomainOnly(event.target.checked)}
                            />
                            Same domain only
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={crawlIncludeSubdomains}
                              onChange={(event) => setCrawlIncludeSubdomains(event.target.checked)}
                            />
                            Include subdomains
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={crawlSeedFromSitemaps}
                              onChange={(event) => setCrawlSeedFromSitemaps(event.target.checked)}
                            />
                            Seed from sitemap.xml
                          </label>
                        </div>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Include URL Patterns (optional)</Label>
                            <Textarea
                              rows={2}
                              placeholder="*docs*\n/blog/"
                              value={crawlIncludePatterns}
                              onChange={(event) => setCrawlIncludePatterns(event.target.value)}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Exclude URL Patterns (optional)</Label>
                            <Textarea
                              rows={2}
                              placeholder="/login\n/cart"
                              value={crawlExcludePatterns}
                              onChange={(event) => setCrawlExcludePatterns(event.target.value)}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                    <Button onClick={onScrape} disabled={scraping || !scrapeUrl.trim()}>
                      {scraping
                        ? scrapeMode === "crawl"
                          ? "Crawling..."
                          : "Scraping..."
                        : scrapeMode === "crawl"
                          ? "Deep Crawl URL"
                          : "Scrape URL"}
                    </Button>
                  </TabsContent>

                  <TabsContent value="connected" className="mt-4 space-y-4">
                    <div className="rounded-md border p-3">
                      <div className="mb-2 text-sm font-semibold">Google Workspace Import</div>
                      <div className="space-y-2">
                        <Label>Mode</Label>
                        <select
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={googleMode}
                          onChange={(event) => setGoogleMode(event.target.value as "gmail" | "drive")}
                        >
                          <option value="gmail">Gmail Snapshot</option>
                          <option value="drive">Drive Snapshot</option>
                        </select>
                      </div>
                      <div className="mt-3 space-y-2">
                        <Label>Query (optional)</Label>
                        <Input
                          placeholder={googleMode === "gmail" ? "label:inbox newer_than:7d" : "name contains 'proposal'"}
                          value={googleQuery}
                          onChange={(event) => setGoogleQuery(event.target.value)}
                        />
                      </div>
                      <div className="mt-3 space-y-2">
                        <Label>Max results</Label>
                        <Input
                          value={googleMaxResults}
                          onChange={(event) => setGoogleMaxResults(event.target.value)}
                          placeholder="5"
                        />
                        <p className="text-xs text-muted-foreground">
                          Uses `gws`. Run `gws auth setup` and `gws auth login` once on this machine, or keep using the existing in-app Google OAuth for workflows.
                        </p>
                      </div>
                      <Button className="mt-3" onClick={onImportGoogle} disabled={importingGoogle}>
                        {importingGoogle ? "Importing..." : `Import ${googleMode === "gmail" ? "Gmail" : "Drive"} Snapshot`}
                      </Button>
                    </div>

                    <div className="rounded-md border p-3 text-xs text-muted-foreground">
                      For public websites, docs portals, or social/profile pages, use the <strong>Web</strong> tab with <strong>Deep Crawl</strong>. It is safer than unofficial social-network clients and can capture many pages in one run.
                    </div>
                  </TabsContent>
                </Tabs>

                {message && <p className="mt-3 text-xs text-muted-foreground">{message}</p>}

                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="mr-1 font-medium text-muted-foreground">Source lifecycle:</span>
                    {["uploaded", "parsed", "indexed"].map((step, i) => {
                      const done = uploadedSource && i < lifecycleStep;
                      return (
                        <span key={step} className="flex items-center gap-1">
                          {done ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : <Circle className="h-3 w-3 text-muted-foreground" />}
                          <span className={done ? "text-foreground" : "text-muted-foreground"}>{step}</span>
                          {i < 2 ? <ChevronRight className="h-3 w-3 text-muted-foreground/50" /> : null}
                        </span>
                      );
                    })}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <div className="rounded-md border p-4">
                <div className="flex items-center gap-1 mb-1">
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowExamples(!showExamples)}
                  >
                    {showExamples ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Chat examples
                  </button>
                </div>
                {showExamples ? (
                  <div className="space-y-1.5 text-sm text-muted-foreground">
                    <p><code className="text-xs">list data sources</code></p>
                    <p><code className="text-xs">search data sources for customer onboarding checklist</code></p>
                    <p><code className="text-xs">show data source &lt;document-id&gt;</code></p>
                    <p><code className="text-xs">create task from data source &lt;document-id&gt; for tomorrow follow-up</code></p>
                    <p><code className="text-xs">backup create</code></p>
                    <p><code className="text-xs">backup verify latest</code></p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Stored Data Sources</CardTitle>
                <CardDescription>Search and select a source to inspect extracted text.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex gap-2">
                  <Input
                    placeholder="Search data sources"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void loadDocs(query.trim());
                      }
                    }}
                  />
                  <Button variant="outline" onClick={() => void loadDocs(query.trim())}>
                    Search
                  </Button>
                </div>

                {loading ? (
                  <p className="text-sm text-muted-foreground">Loading...</p>
                ) : sortedDocs.length === 0 ? (
                  hideGettingStarted ? (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
                      <p className="text-sm text-muted-foreground">No data sources yet.</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setHideGettingStarted(false)}
                      >
                        Show Tips
                      </Button>
                    </div>
                  ) : (
                    <div className="rounded-md border bg-muted/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                            Getting Started
                          </div>
                          <p className="mt-2 text-sm font-medium">Add a data source before using document recall.</p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            Upload a file, scrape a URL, or import a small Gmail/Drive snapshot. WebChat can then list,
                            search, inspect, and create tasks from stored sources.
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setHideGettingStarted(true)}
                        >
                          Hide Tips
                        </Button>
                      </div>
                    </div>
                  )
                ) : (
                  <div className="space-y-2">
                    {sortedDocs.map((doc) => {
                      const active = selectedId === doc.id;
                      const warningCount = Number(doc.metadata?.warningCount || 0);
                      const highestSeverity = String(doc.metadata?.highestWarningSeverity || "");
                      const pagesCrawled = Number(doc.metadata?.pagesCrawled || 0);
                      const crawlSeedMode = String(doc.metadata?.crawlSeedMode || "");
                      return (
                        <div
                          key={doc.id}
                          className={`rounded-md border p-3 ${active ? "border-primary" : "border-border"}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <button
                              type="button"
                              className="flex-1 text-left"
                              onClick={() => setSelectedId(doc.id)}
                            >
                              <div className="text-sm font-semibold">{doc.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {doc.sourceType} • {formatSize(doc.sizeBytes)} • {new Date(doc.createdAt).toLocaleString()}
                              </div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {warningCount > 0 ? (
                                  <Badge variant={highestSeverity === "high" ? "destructive" : "outline"} className="text-[10px]">
                                    {warningCount} warning{warningCount === 1 ? "" : "s"}
                                  </Badge>
                                ) : null}
                                {pagesCrawled > 1 ? (
                                  <Badge variant="secondary" className="text-[10px]">
                                    {pagesCrawled} pages
                                  </Badge>
                                ) : null}
                                {crawlSeedMode === "sitemap+links" ? (
                                  <Badge variant="outline" className="text-[10px]">
                                    sitemap seeded
                                  </Badge>
                                ) : null}
                              </div>
                              {doc.sourceUrl && (
                                <div className="mt-1 truncate text-xs text-muted-foreground">{doc.sourceUrl}</div>
                              )}
                              <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">{doc.excerpt}</div>
                            </button>
                            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(doc)}>
                              Delete
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Extracted Content</CardTitle>
                <CardDescription>
                  {selected ? `${selected.name} (${selected.id})` : "Select a source to view extracted content."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {selected ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="h-8 px-3 py-2">Send to...</Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => router.push(`/boards?documentId=${encodeURIComponent(selected.id)}`)}
                      >
                        Open In Boards
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => router.push(`/workflows?template=document-intelligence&documentId=${encodeURIComponent(selected.id)}`)}
                      >
                        Open In Workflows
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          router.push(
                            `/council?documentId=${encodeURIComponent(selected.id)}&topic=${encodeURIComponent(`What should the team decide after reviewing data source ${selected.name}?`)}`,
                          )
                        }
                      >
                        Open In Council
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => router.push(`/memory?documentId=${encodeURIComponent(selected.id)}`)}
                      >
                        Inspect In Memory
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {Number(selected.metadata?.warningCount || 0) > 0 ? (
                        <Badge
                          variant={String(selected.metadata?.highestWarningSeverity || "") === "high" ? "destructive" : "outline"}
                        >
                          {Number(selected.metadata?.warningCount || 0)} safety warning(s)
                        </Badge>
                      ) : null}
                      {Number(selected.metadata?.pagesCrawled || 0) > 1 ? (
                        <Badge variant="secondary">{Number(selected.metadata?.pagesCrawled || 0)} pages crawled</Badge>
                      ) : null}
                      {String(selected.metadata?.crawlSeedMode || "") === "sitemap+links" ? (
                        <Badge variant="outline">sitemap seeded</Badge>
                      ) : null}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-md border bg-muted/20 p-3">
                        <div className="text-[11px] uppercase text-muted-foreground">Source URL</div>
                        <div className="mt-1 line-clamp-2 text-xs">{selected.sourceUrl || "-"}</div>
                      </div>
                      <div className="rounded-md border bg-muted/20 p-3">
                        <div className="text-[11px] uppercase text-muted-foreground">Crawl Strategy</div>
                        <div className="mt-1 text-sm font-medium">
                          {String(selected.metadata?.strategyRequested || selected.metadata?.mode || "n/a")}
                        </div>
                      </div>
                      <div className="rounded-md border bg-muted/20 p-3">
                        <div className="text-[11px] uppercase text-muted-foreground">Seed Mode</div>
                        <div className="mt-1 text-sm font-medium">
                          {String(selected.metadata?.crawlSeedMode || "direct")}
                        </div>
                      </div>
                      <div className="rounded-md border bg-muted/20 p-3">
                        <div className="text-[11px] uppercase text-muted-foreground">Page Discovery</div>
                        <div className="mt-1 text-sm font-medium">
                          {Number(selected.metadata?.pagesCrawled || 0)} / {Number(selected.metadata?.pagesDiscovered || 0)} pages
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                      {selectedQualityIndicators.map((indicator) => (
                        <div key={indicator.label} className="rounded-md border bg-muted/20 p-3">
                          <div className="text-[11px] uppercase text-muted-foreground">{indicator.label}</div>
                          <div className="mt-1 text-sm font-medium">{indicator.value}</div>
                        </div>
                      ))}
                    </div>
                    {selectedWarnings.length > 0 ? (
                      <div className="rounded-md border p-3">
                        <div className="mb-2 text-sm font-medium">Safety Warnings</div>
                        <div className="space-y-2">
                          {selectedWarnings.slice(0, 6).map((warning, index) => (
                            <div key={`${warning.code || "warning"}-${index}`} className="rounded-md border bg-muted/20 p-2 text-xs">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">{String(warning.code || "warning")}</span>
                                <Badge variant={String(warning.severity || "") === "high" ? "destructive" : "outline"}>
                                  {String(warning.severity || "low")}
                                </Badge>
                              </div>
                              <div className="mt-1 text-muted-foreground">{String(warning.message || "")}</div>
                              {warning.match ? (
                                <div className="mt-1 truncate font-mono text-[11px]">{String(warning.match)}</div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {selectedPages.length > 0 ? (
                      <div className="rounded-md border p-3">
                        <div className="mb-2 text-sm font-medium">Crawled Pages</div>
                        <div className="space-y-2">
                          {selectedPages.slice(0, 8).map((page, index) => (
                            <div key={`${page.url || "page"}-${index}`} className="rounded-md border bg-muted/20 p-2 text-xs">
                              <div className="font-medium">{String(page.title || page.url || `Page ${index + 1}`)}</div>
                              <div className="truncate text-muted-foreground">{String(page.url || "")}</div>
                              <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                                <span>depth {String(page.depth ?? "-")}</span>
                                <span>{String(page.strategyUsed || "auto")}</span>
                                <span>{formatSize(Number(page.sizeBytes || 0))}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {selectedErrors.length > 0 ? (
                      <div className="rounded-md border p-3">
                        <div className="mb-2 text-sm font-medium">Crawl Errors</div>
                        <div className="space-y-2">
                          {selectedErrors.slice(0, 5).map((errorRow, index) => (
                            <div key={`${errorRow.url || "error"}-${index}`} className="rounded-md border bg-muted/20 p-2 text-xs">
                              <div className="truncate font-medium">{String(errorRow.url || "crawl error")}</div>
                              <div className="mt-1 text-muted-foreground">{String(errorRow.error || "")}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <textarea
                      readOnly
                      value={selected.extractedText}
                      className="h-[480px] w-full resize-none rounded-md border bg-background p-3 font-mono text-xs"
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No source selected.</p>
                )}
              </CardContent>
            </Card>
          </div>
          <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Data Source</DialogTitle>
                <DialogDescription>
                  Delete &quot;{deleteTarget?.name || "this source"}&quot;? Extracted text, crawl metadata, and future cross-tab handoffs for this source will be removed.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <div><strong>Type:</strong> {deleteTarget?.sourceType || "-"}</div>
                <div><strong>Size:</strong> {deleteTarget ? formatSize(deleteTarget.sizeBytes) : "-"}</div>
                <div className="truncate"><strong>Source:</strong> {deleteTarget?.sourceUrl || deleteTarget?.id || "-"}</div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deletingDocument}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteTarget && void onDelete(deleteTarget.id)}
                  disabled={deletingDocument}
                >
                  {deletingDocument ? "Deleting..." : "Delete Source"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          </>
          )}
        </main>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense>
      <DocumentsPageInner />
    </Suspense>
  );
}
