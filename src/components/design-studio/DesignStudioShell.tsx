"use client";

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { DesignActivityPanel } from "@/components/design-studio/DesignActivityPanel";
import { DesignPreviewFrame } from "@/components/design-studio/DesignPreviewFrame";
import { DesignProjectRail } from "@/components/design-studio/DesignProjectRail";
import { DesignSourcePanel } from "@/components/design-studio/DesignSourcePanel";
import { DesignToolbar } from "@/components/design-studio/DesignToolbar";
import { ManualEditPanel } from "@/components/design-studio/manual/ManualEditPanel";
import type { DesignEditTarget, DesignPreviewMode } from "@/components/design-studio/preview/selection-types";
import { ValidationPanel } from "@/components/design-studio/validation/ValidationPanel";
import type { DesignArtifactSummary, DesignProjectSummary, HtmlValidationResult } from "@/components/design-studio/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { extractDesignEditTargets } from "@/lib/design-studio/edit-targets";
import { extractCssTokens } from "@/lib/design-studio/tokens";

const starterHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>New Design</title>
  <style>
    :root { color-scheme: dark; --disp8ch-bg: #101114; --disp8ch-panel: #181b20; --disp8ch-text: #f1f5f9; --disp8ch-muted: #9aa4b2; --disp8ch-accent: #d34a38; --disp8ch-radius: 8px; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Inter, system-ui, sans-serif; background: var(--disp8ch-bg); color: var(--disp8ch-text); }
    main { min-height: 100vh; display: grid; place-items: center; padding: 48px 20px; }
    section { width: min(920px, 100%); border: 1px solid rgba(255,255,255,.12); border-radius: var(--disp8ch-radius); background: var(--disp8ch-panel); padding: 36px; }
    h1 { margin: 0 0 12px; font-size: clamp(32px, 6vw, 64px); line-height: 1; }
    p { margin: 0; color: var(--disp8ch-muted); font-size: 18px; line-height: 1.6; }
    a { display: inline-flex; margin-top: 24px; color: white; background: var(--disp8ch-accent); padding: 12px 16px; border-radius: 6px; text-decoration: none; font-weight: 700; }
  </style>
</head>
<body>
  <main data-disp8ch-id="page" data-disp8ch-edit="container" data-disp8ch-label="Page">
    <section data-disp8ch-id="hero" data-disp8ch-edit="container" data-disp8ch-label="Hero">
      <h1 data-disp8ch-id="hero-title" data-disp8ch-edit="text">Design Studio Artifact</h1>
      <p data-disp8ch-id="hero-copy" data-disp8ch-edit="text">A complete standalone HTML canvas, versioned inside disp8ch AI.</p>
      <a data-disp8ch-id="hero-cta" data-disp8ch-edit="link" href="#">Primary action</a>
    </section>
  </main>
</body>
</html>`;

type SourcePayload = {
  artifact: DesignArtifactSummary;
  source: string;
  validation: HtmlValidationResult;
};

type ImportMode = "html" | "image";

const maxImportedHtmlChars = 920_000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```[a-z0-9_-]*\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || "Imported Design";
}

function titleFromFilename(filename: string): string {
  return normalizeTitle(filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
}

function hasCompleteHtmlDocument(source: string): boolean {
  return /<!doctype\s+html/i.test(source) || (/<html[\s>]/i.test(source) && /<body[\s>]/i.test(source));
}

function looksLikeHtmlSnippet(source: string): boolean {
  return /<\/?[a-z][\w:-]*(\s|>|\/)/i.test(source);
}

function buildHtmlShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --page-bg: #0d1117; --panel: #151b23; --text: #f5f7fb; --muted: #9aa4b2; --accent: #d34a38; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--page-bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { min-height: 100vh; padding: 40px 20px; }
  </style>
</head>
<body>
  <main data-disp8ch-id="imported-design" data-disp8ch-edit="container" data-disp8ch-label="Imported design">
${body}
  </main>
</body>
</html>`;
}

function buildSourceReferenceHtml(title: string, source: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; --bg: #0d1117; --panel: #151b23; --border: rgba(255,255,255,.14); --text: #f5f7fb; --muted: #9aa4b2; --accent: #d34a38; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, rgba(211,74,56,.18), transparent 32rem), var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    main { width: min(1100px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
    section { border: 1px solid var(--border); background: color-mix(in srgb, var(--panel) 92%, transparent); padding: 24px; }
    h1 { margin: 0 0 10px; font-size: clamp(28px, 5vw, 56px); line-height: .95; letter-spacing: -.04em; }
    p { margin: 0 0 20px; color: var(--muted); line-height: 1.6; }
    pre { margin: 0; overflow: auto; white-space: pre-wrap; border: 1px solid var(--border); background: rgba(0,0,0,.28); padding: 18px; color: #d7e3f5; font-size: 13px; line-height: 1.55; }
  </style>
</head>
<body>
  <main data-disp8ch-id="source-reference" data-disp8ch-edit="container" data-disp8ch-label="Source reference">
    <section>
      <h1 data-disp8ch-id="source-title" data-disp8ch-edit="text">${escapeHtml(title)}</h1>
      <p data-disp8ch-id="source-note" data-disp8ch-edit="text">This import is source code, not a standalone HTML page. It is saved here as a reference. To make it live, convert it to standalone HTML/CSS and paste it back into Import.</p>
      <pre data-disp8ch-id="source-code" data-disp8ch-edit="text"><code>${escapeHtml(source)}</code></pre>
    </section>
  </main>
</body>
</html>`;
}

function buildImageImportHtml(title: string, imageSource: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; --bg: #0d1117; --panel: #151b23; --border: rgba(255,255,255,.14); --text: #f5f7fb; --muted: #9aa4b2; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 32px; }
    figure { width: min(1120px, 100%); margin: 0; border: 1px solid var(--border); background: var(--panel); padding: 18px; }
    img { display: block; width: 100%; height: auto; object-fit: contain; background: rgba(255,255,255,.04); }
    figcaption { margin-top: 14px; color: var(--muted); font-size: 14px; }
  </style>
</head>
<body>
  <main data-disp8ch-id="image-page" data-disp8ch-edit="container" data-disp8ch-label="Image page">
    <figure data-disp8ch-id="image-card" data-disp8ch-edit="container" data-disp8ch-label="Image card">
      <img data-disp8ch-id="imported-image" data-disp8ch-edit="image" src="${escapeHtml(imageSource)}" alt="${escapeHtml(title)}">
      <figcaption data-disp8ch-id="image-caption" data-disp8ch-edit="text">${escapeHtml(title)}</figcaption>
    </figure>
  </main>
</body>
</html>`;
}

function normalizeImportedSource(title: string, rawSource: string): { html: string; summary: string } {
  const source = stripMarkdownFence(rawSource);
  if (!source) throw new Error("Paste HTML/source first.");
  if (hasCompleteHtmlDocument(source)) return { html: source, summary: "Imported standalone HTML" };
  if (looksLikeHtmlSnippet(source)) return { html: buildHtmlShell(title, source), summary: "Imported HTML snippet" };
  return { html: buildSourceReferenceHtml(title, source), summary: "Imported source reference" };
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

export function DesignStudioShell() {
  const [projects, setProjects] = useState<DesignProjectSummary[]>([]);
  const [artifacts, setArtifacts] = useState<DesignArtifactSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<DesignArtifactSummary | null>(null);
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [validation, setValidation] = useState<HtmlValidationResult | null>(null);
  const [mode, setMode] = useState<DesignPreviewMode>("preview");
  const [targets, setTargets] = useState<DesignEditTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<DesignEditTarget | null>(null);
  const [previewReport, setPreviewReport] = useState<any | null>(null);
  const [checkingPreview, setCheckingPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("html");
  const [importTitle, setImportTitle] = useState("Imported Design");
  const [importSource, setImportSource] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const activeArtifactId = activeArtifact?.id ?? null;

  const resetArtifactState = useCallback(() => {
    setActiveArtifact(null);
    setSource("");
    setSavedSource("");
    setValidation(null);
    setTargets([]);
    setSelectedTarget(null);
    setPreviewReport(null);
  }, []);

  async function refreshProjectsOnly() {
    const res = await fetch("/api/design/bootstrap", { cache: "no-store" });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Bootstrap failed");
    setProjects(json.data.projects as DesignProjectSummary[]);
  }

  async function loadArtifactSource(artifactId: string) {
    const res = await fetch(`/api/design/artifacts/${encodeURIComponent(artifactId)}/source`, { cache: "no-store" });
    const json = await res.json() as { success: boolean; data?: SourcePayload; error?: string };
    if (!json.success || !json.data) throw new Error(json.error || "Source load failed");
    const nextTargets = extractDesignEditTargets(json.data.source);
    setActiveArtifact(json.data.artifact);
    setSource(json.data.source);
    setSavedSource(json.data.source);
    setValidation(json.data.validation);
    setTargets(nextTargets);
    setSelectedTarget(nextTargets[0] ?? null);
    setPreviewReport(null);
  }

  async function loadArtifacts(projectId: string, preferredArtifactId?: string | null) {
    const res = await fetch(`/api/design/projects/${encodeURIComponent(projectId)}/artifacts`, { cache: "no-store" });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Artifact load failed");
    const nextArtifacts = json.data as DesignArtifactSummary[];
    setArtifacts(nextArtifacts);
    const selected = nextArtifacts.find((item) => item.id === preferredArtifactId) ?? nextArtifacts[0] ?? null;
    if (selected) await loadArtifactSource(selected.id);
    else resetArtifactState();
  }

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/design/bootstrap", { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Bootstrap failed");
      const nextProjects = json.data.projects as DesignProjectSummary[];
      setProjects(nextProjects);
      const firstProject = activeProjectId
        ? nextProjects.find((project) => project.id === activeProjectId)
        : nextProjects[0];
      if (firstProject) {
        setActiveProjectId(firstProject.id);
        await loadArtifacts(firstProject.id, firstProject.activeArtifactId);
      } else {
        setArtifacts([]);
        setActiveProjectId(null);
        resetArtifactState();
      }
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, resetArtifactState]);

  useEffect(() => {
    void loadBootstrap();
  }, []);

  const handleCreateProject = useCallback(async () => {
    const name = window.prompt("Project name", "New Design Project");
    if (!name) return;
    const res = await fetch("/api/design/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = await res.json();
    if (!json.success) {
      window.alert(json.error || "Could not create project");
      return;
    }
    setActiveProjectId(json.data.id);
    await loadBootstrap();
  }, [loadBootstrap]);

  const handleCreateArtifact = useCallback(async () => {
    if (!activeProjectId) return;
    const title = window.prompt("Artifact title", "New HTML Artifact");
    if (!title) return;
    const res = await fetch(`/api/design/projects/${encodeURIComponent(activeProjectId)}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, html: starterHtml, summary: "Created from starter HTML" }),
    });
    const json = await res.json();
    if (!json.success) {
      window.alert(json.error || "Could not create artifact");
      return;
    }
    await loadArtifacts(activeProjectId, json.data.id);
    await loadBootstrap();
  }, [activeProjectId, loadBootstrap]);

  const handleImportTextFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportError(null);
    try {
      setImportMode("html");
      setImportTitle(titleFromFilename(file.name));
      setImportSource(await readFileAsText(file));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read file");
    }
  }, []);

  const handleImportImageFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportError(null);
    if (!file.type.startsWith("image/")) {
      setImportError("Choose an image file.");
      return;
    }
    if (file.size > 650_000) {
      setImportError("This image is too large for the 1 MB self-contained design artifact limit. Use a smaller image or paste an image URL.");
      return;
    }
    try {
      setImportMode("image");
      setImportTitle(titleFromFilename(file.name));
      setImportSource(await readFileAsDataUrl(file));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read image");
    }
  }, []);

  const handleImportDesign = useCallback(async () => {
    setImportError(null);
    setImportBusy(true);
    try {
      const title = normalizeTitle(importTitle);
      let html: string;
      let summary: string;
      if (importMode === "image") {
        const imageSource = importSource.trim();
        if (!imageSource) throw new Error("Choose an image file or paste an image URL first.");
        if (!/^(data:image\/|https?:\/\/|\/[^/])/i.test(imageSource)) {
          throw new Error("Use an image file, an http(s) image URL, or a data:image URL.");
        }
        html = buildImageImportHtml(title, imageSource);
        summary = "Imported image as standalone design";
      } else {
        const normalized = normalizeImportedSource(title, importSource);
        html = normalized.html;
        summary = normalized.summary;
      }
      if (html.length > maxImportedHtmlChars) {
        throw new Error("The imported design is too large for the 1 MB artifact limit.");
      }

      let projectId = activeProjectId;
      if (!projectId) {
        const projectRes = await fetch("/api/design/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Imported Designs", description: "Designs imported from files, images, or pasted source." }),
        });
        const projectJson = await projectRes.json();
        if (!projectJson.success) throw new Error(projectJson.error || "Could not create import project");
        projectId = projectJson.data.id as string;
        setActiveProjectId(projectId);
      }

      const artifactRes = await fetch(`/api/design/projects/${encodeURIComponent(projectId)}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, html, summary }),
      });
      const artifactJson = await artifactRes.json();
      if (!artifactJson.success) throw new Error(artifactJson.error || "Could not import design");

      setActiveProjectId(projectId);
      await loadArtifacts(projectId, artifactJson.data.id);
      await refreshProjectsOnly();
      setImportOpen(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed");
    } finally {
      setImportBusy(false);
    }
  }, [activeProjectId, importMode, importSource, importTitle]);

  const handleSelectProject = useCallback(async (projectId: string) => {
    if (source !== savedSource && !window.confirm("Discard unsaved source changes?")) return;
    setActiveProjectId(projectId);
    await loadArtifacts(projectId);
  }, [source, savedSource]);

  const handleSelectArtifact = useCallback(async (artifactId: string) => {
    if (source !== savedSource && !window.confirm("Discard unsaved source changes?")) return;
    await loadArtifactSource(artifactId);
  }, [source, savedSource]);

  const handleSave = useCallback(async () => {
    if (!activeArtifact) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/design/artifacts/${encodeURIComponent(activeArtifact.id)}/source`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ html: source, summary: "Saved from Designs source editor" }),
      });
      const json = await res.json();
      if (!json.success) {
        window.alert(json.error || "Save failed");
        return;
      }
      await loadArtifactSource(activeArtifact.id);
      if (activeProjectId) await loadArtifacts(activeProjectId, activeArtifact.id);
    } finally {
      setSaving(false);
    }
  }, [activeArtifact, activeProjectId, source]);

  const handlePatch = useCallback(async (patch: unknown, summary: string) => {
    if (!activeArtifact) return;
    const res = await fetch(`/api/design/artifacts/${encodeURIComponent(activeArtifact.id)}/patch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch, summary, source: "manual" }),
    });
    const json = await res.json();
    if (!json.success) {
      window.alert(json.error || "Patch failed");
      return;
    }
    await loadArtifactSource(activeArtifact.id);
    if (activeProjectId) await loadArtifacts(activeProjectId, activeArtifact.id);
  }, [activeArtifact, activeProjectId]);

  const handleRunCheck = useCallback(async () => {
    if (!activeArtifact) return;
    setCheckingPreview(true);
    try {
      const res = await fetch(`/api/design/artifacts/${encodeURIComponent(activeArtifact.id)}/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visual: true }),
      });
      const json = await res.json();
      if (!json.success) {
        window.alert(json.error || "Preview check failed");
        return;
      }
      setPreviewReport(json.data);
    } finally {
      setCheckingPreview(false);
    }
  }, [activeArtifact]);

  const handleExportHtml = useCallback(() => {
    if (!activeArtifact) return;
    window.open(`/api/design/artifacts/${encodeURIComponent(activeArtifact.id)}/export`, "_blank");
  }, [activeArtifact]);

  const previewTitle = useMemo(() => activeArtifact?.title || "Design Preview", [activeArtifact]);
  const tokens = useMemo(() => extractCssTokens(source), [source]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <DesignToolbar
        disabled={!activeArtifact}
        newArtifactDisabled={!activeProjectId}
        onImportArtifact={() => {
          setImportError(null);
          setImportOpen(true);
        }}
        onNewArtifact={handleCreateArtifact}
        onRefresh={loadBootstrap}
        onExportHtml={handleExportHtml}
      />
      <div className="flex min-h-0 flex-1">
        <DesignProjectRail
          projects={projects}
          artifacts={artifacts}
          activeProjectId={activeProjectId}
          activeArtifactId={activeArtifactId}
          onCreateProject={handleCreateProject}
          onSelectProject={handleSelectProject}
          onSelectArtifact={handleSelectArtifact}
        />
        {activeArtifact ? (
          <DesignPreviewFrame
            title={previewTitle}
            source={source}
            validation={validation}
            mode={mode}
            selectedTargetId={selectedTarget?.id ?? null}
            onTargets={setTargets}
            onSelectTarget={setSelectedTarget}
          />
        ) : (
          <section className="flex min-w-0 flex-1 items-center justify-center border-r border-border bg-background p-6">
            <div className="w-full max-w-2xl border border-border bg-card/60 p-6 shadow-sm">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-terminal-red">Start here</div>
              <h2 className="text-2xl font-semibold">Import a design, image, or source file</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                Upload a screenshot/mockup image, paste standalone HTML, or keep React/Tailwind/source code as a reference artifact.
                Uploaded files become project context that you can open and refine in the design workspace.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <Button
                  className="h-auto flex-col items-start gap-1 whitespace-normal py-4 text-left"
                  variant="outline"
                  onClick={() => {
                    setImportMode("image");
                    setImportError(null);
                    setImportOpen(true);
                  }}
                >
                  <span className="font-semibold">Upload image</span>
                  <span className="text-xs font-normal text-muted-foreground">Screenshot, mockup, logo, or visual reference.</span>
                </Button>
                <Button
                  className="h-auto flex-col items-start gap-1 whitespace-normal py-4 text-left"
                  variant="outline"
                  onClick={() => {
                    setImportMode("html");
                    setImportError(null);
                    setImportOpen(true);
                  }}
                >
                  <span className="font-semibold">Upload code</span>
                  <span className="text-xs font-normal text-muted-foreground">HTML, JSX, TSX, JS, CSS, Markdown, or text.</span>
                </Button>
                <Button
                  className="h-auto flex-col items-start gap-1 whitespace-normal py-4 text-left"
                  variant="outline"
                  onClick={handleCreateArtifact}
                  disabled={!activeProjectId}
                >
                  <span className="font-semibold">Blank HTML</span>
                  <span className="text-xs font-normal text-muted-foreground">Start with an editable standalone page.</span>
                </Button>
              </div>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Best generation path today: import a reference, then ask WebChat or edit the HTML source. Uploaded source code is saved safely as reference text unless it is standalone HTML.
              </p>
            </div>
          </section>
        )}
        <ManualEditPanel
          mode={mode}
          targets={targets}
          selectedTarget={selectedTarget}
          tokens={tokens}
          onModeChange={setMode}
          onSelectTarget={setSelectedTarget}
          onPatch={handlePatch}
        />
        <DesignSourcePanel
          source={source}
          savedSource={savedSource}
          validation={validation}
          versionNumber={activeArtifact?.currentVersionNumber ?? null}
          saving={saving}
          onChange={setSource}
          onSave={handleSave}
          onRevert={() => setSource(savedSource)}
        />
      </div>
      <ValidationPanel report={previewReport} onRunCheck={handleRunCheck} checking={checkingPreview} />
      <DesignActivityPanel validation={validation} />
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (open) setImportError(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import a Design</DialogTitle>
            <DialogDescription>
              Add a pasted HTML page, source reference, or image. The app saves it as a Design Studio artifact you can preview, edit, and export.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={importMode === "html" ? "default" : "outline"}
                onClick={() => {
                  setImportMode("html");
                  setImportError(null);
                }}
              >
                HTML or source
              </Button>
              <Button
                type="button"
                size="sm"
                variant={importMode === "image" ? "default" : "outline"}
                onClick={() => {
                  setImportMode("image");
                  setImportError(null);
                }}
              >
                Image
              </Button>
              <Badge variant="outline" className="ml-auto">
                {activeProjectId ? "Adds to current project" : "Creates project if needed"}
              </Badge>
            </div>

            <div className="grid gap-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="design-import-title">
                Design name
              </label>
              <Input
                id="design-import-title"
                value={importTitle}
                onChange={(event) => setImportTitle(event.target.value)}
                placeholder="Landing page concept"
              />
            </div>

            {importMode === "html" ? (
              <div className="grid gap-3">
                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="design-import-file">
                    Upload file
                  </label>
                  <Input
                    id="design-import-file"
                    type="file"
                    accept=".html,.htm,.txt,.md,.jsx,.tsx,.js,.ts,.css"
                    onChange={handleImportTextFile}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="design-import-source">
                    Or paste HTML/source
                  </label>
                  <Textarea
                    id="design-import-source"
                    className="min-h-[220px]"
                    value={importSource}
                    onChange={(event) => setImportSource(event.target.value)}
                    placeholder={`Paste a full standalone HTML document here.\n\nReact/Tailwind/source code can be imported as a reference, or converted to standalone HTML/CSS first for live preview.`}
                  />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Best result: paste exported standalone HTML from Claude Code or any builder. Plain React/Tailwind source is kept as a source reference until converted.
                </p>
              </div>
            ) : (
              <div className="grid gap-3">
                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="design-import-image-file">
                    Upload image
                  </label>
                  <Input id="design-import-image-file" type="file" accept="image/*" onChange={handleImportImageFile} />
                </div>
                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="design-import-image-source">
                    Or paste image URL
                  </label>
                  <Textarea
                    id="design-import-image-source"
                    className="min-h-[84px]"
                    value={importSource}
                    onChange={(event) => setImportSource(event.target.value)}
                    placeholder="https://example.com/mockup.png"
                  />
                </div>
                {importSource.trim() ? (
                  <div className="max-h-52 overflow-hidden border border-border bg-muted/20 p-2">
                    <img src={importSource.trim()} alt="Import preview" className="max-h-48 w-full object-contain" />
                  </div>
                ) : null}
                <p className="text-xs leading-5 text-muted-foreground">
                  Small uploaded images are embedded into the exported HTML. For large images, paste a web URL.
                </p>
              </div>
            )}

            {importError ? (
              <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {importError}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImportOpen(false)} disabled={importBusy}>
              Cancel
            </Button>
            <Button type="button" onClick={handleImportDesign} disabled={importBusy || !importSource.trim()}>
              {importBusy ? "Importing..." : "Import design"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {loading ? <div className="pointer-events-none fixed bottom-3 right-3 text-xs text-muted-foreground">Loading designs...</div> : null}
    </div>
  );
}
