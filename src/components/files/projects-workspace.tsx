"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, Braces, ExternalLink, FileCode2, GitCompareArrows, Loader2, MonitorPlay,
  Network, Plus, RefreshCw, Search, ShieldCheck, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDesktopBridge } from "@/lib/client/desktop-bridge";
import type { ConnectedProject, ProjectEdge, ProjectFile, ProjectImpactReport, ProjectSymbol } from "@/lib/projects/types";
import { ProjectDeploymentPanel } from "./project-deployment-panel";

type Detail = { project: ConnectedProject; files: ProjectFile[]; symbols: ProjectSymbol[]; edges: ProjectEdge[]; impacts: ProjectImpactReport[] };
type Citation = { path: string; startLine: number; endLine: number };
type Highlight = Citation | null;
type CenterSurface = "source" | "preview";
type ExplorerMode = "files" | "map";

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);

function previewToken(value: string): string {
  if (typeof window === "undefined") return "";
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function citationLabel(citation: Citation): string {
  return `${citation.path}:L${citation.startLine}${citation.endLine === citation.startLine ? "" : `-L${citation.endLine}`}`;
}

function SourceAnswer({ answer, onCitation }: { answer: string; onCitation: (citation: Citation) => void }) {
  const parts = answer.split(/(\[[^\]\n]+:L\d+(?:-L\d+)?\])/g);
  return <div className="whitespace-pre-wrap text-xs leading-5">{parts.map((part, index) => {
    const match = part.match(/^\[([^\]\n]+):L(\d+)(?:-L(\d+))?\]$/);
    if (!match) return <span key={index}>{part}</span>;
    const citation = { path: match[1], startLine: Number(match[2]), endLine: Number(match[3] || match[2]) };
    return <button key={`${part}-${index}`} type="button" className="mx-0.5 border-b border-terminal-red font-mono text-[10px] text-terminal-red hover:bg-terminal-red/10" onClick={() => onCitation(citation)}>{part}</button>;
  })}</div>;
}

export function ProjectsWorkspace() {
  const searchParams = useSearchParams();
  const codeScroller = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<ConnectedProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [root, setRoot] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [explorerMode, setExplorerMode] = useState<ExplorerMode>("files");
  const [centerSurface, setCenterSurface] = useState<CenterSurface>("source");
  const [previewOutput, setPreviewOutput] = useState("dist");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [impact, setImpact] = useState<ProjectImpactReport | null>(null);
  const requestedProjectId = String(searchParams.get("project") || "").trim();

  const loadProjects = useCallback(async () => {
    const response = await fetch("/api/projects");
    const json = await response.json();
    if (!json.success) throw new Error(errorText(json.error));
    setProjects(json.data || []);
    if (!projectId) {
      const requested = json.data?.find((project: ConnectedProject) => project.id === requestedProjectId);
      if (requested) setProjectId(requested.id);
      else if (json.data?.[0]) setProjectId(json.data[0].id);
    }
  }, [projectId, requestedProjectId]);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    const response = await fetch(`/api/projects/${id}`);
    const json = await response.json();
    if (!json.success) throw new Error(errorText(json.error));
    setDetail(json.data);
    setImpact(json.data.impacts?.[0] || null);
  }, []);

  const readFile = useCallback(async (relativePath: string, nextHighlight: Highlight = null) => {
    if (!projectId) return;
    setSelectedFile(relativePath);
    setHighlight(nextHighlight);
    setCenterSurface("source");
    setBusy("file");
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/file?path=${encodeURIComponent(relativePath)}`);
      const json = await response.json();
      if (!json.success) throw new Error(errorText(json.error));
      setFileContent(json.data.content);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(""); }
  }, [projectId]);

  useEffect(() => { void loadProjects().catch((value) => setError(errorText(value))); }, [loadProjects]);
  useEffect(() => {
    setSelectedFile(""); setFileContent(""); setHighlight(null); setAnswer(""); setCitations([]); setCenterSurface("source");
    void loadDetail(projectId).catch((value) => setError(errorText(value)));
  }, [loadDetail, projectId]);
  useEffect(() => {
    if (detail?.files[0] && !selectedFile) void readFile(detail.files[0].relativePath);
  }, [detail, readFile, selectedFile]);
  useEffect(() => {
    if (!highlight || selectedFile !== highlight.path) return;
    const line = codeScroller.current?.querySelector<HTMLElement>(`[data-source-line="${highlight.startLine}"]`);
    line?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [fileContent, highlight, selectedFile]);

  const connect = async () => {
    if (!confirmed) return;
    setBusy("connect"); setError("");
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root, confirmed: true }) });
      const json = await response.json();
      if (!json.success) throw new Error(errorText(json.error));
      setProjectId(json.data.project.id); setRoot(""); setConfirmed(false); setConnectOpen(false);
      await loadProjects(); await loadDetail(json.data.project.id);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(""); }
  };

  const pickProject = async () => {
    const bridge = getDesktopBridge(); if (!bridge) return;
    const selected = await bridge.selectProjectDirectory();
    if (selected.ok && selected.path) { setRoot(selected.path); setConfirmed(false); }
  };

  const scan = async () => {
    if (!projectId) return;
    setBusy("scan"); setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "scan" }) });
      const json = await response.json();
      if (!json.success) throw new Error(errorText(json.error));
      await loadDetail(projectId);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(""); }
  };

  const revealCitation = useCallback((citation: Citation) => {
    void readFile(citation.path, citation);
  }, [readFile]);

  const openPreview = useCallback(async (outputPath: string) => {
    const nextOutput = outputPath.trim();
    if (!projectId || !nextOutput) return;
    setBusy("preview"); setError("");
    try {
      const url = `/api/projects/${encodeURIComponent(projectId)}/preview/${previewToken(nextOutput)}/index.html`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const json = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(errorText(json?.error || `Preview returned HTTP ${response.status}.`));
      }
      setPreviewOutput(nextOutput); setCenterSurface("preview");
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(""); }
  }, [projectId]);

  const ask = async () => {
    const prompt = question.trim(); if (!prompt) return;
    setBusy("ask"); setError(""); setAnswer(""); setCitations([]);
    try {
      const response = await fetch(`/api/projects/${projectId}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: prompt }) });
      const json = await response.json();
      if (!json.success) throw new Error(errorText(json.error));
      const nextCitations = (json.data.citations || []) as Citation[];
      setAnswer(json.data.answer); setCitations(nextCitations);
      if (nextCitations[0]) await readFile(nextCitations[0].path, nextCitations[0]);
      if (/\b(html|website|webpage|web page|landing page|static site|preview)\b/i.test(prompt)) {
        await openPreview("dist");
      }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(""); }
  };

  const analyzeImpact = async () => {
    setBusy("impact"); setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/impact`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const json = await response.json();
      if (!json.success) throw new Error(errorText(json.error));
      setImpact(json.data); await loadDetail(projectId);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(""); }
  };

  const confirmedAction = async (action: "save_impact_notebook" | "create_impact_task" | "start_supervised_run") => {
    if (!impact) return;
    const prompt = action === "save_impact_notebook" ? "Save this exact impact report to a new Notebook?" : action === "create_impact_task" ? "Create a linked Board task from this exact impact report?" : "Generate a model-backed acceptance contract and start a supervised run inside this confirmed project root?";
    if (!window.confirm(prompt)) return;
    setBusy(action);
    try {
      const response = await fetch(`/api/projects/${projectId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, impactId: impact.id, confirmed: true }) });
      const json = await response.json();
      if (!json.success) throw new Error(errorText(json.error));
      if (action === "start_supervised_run") window.location.href = `/workflows?run=${encodeURIComponent(json.data.id)}&trail=${encodeURIComponent(detail?.project.workTrailId || "")}`;
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(""); }
  };

  const graph = useMemo(() => {
    if (!detail) return [];
    const byId = new Map(detail.files.map((file) => [file.id, file.relativePath]));
    return detail.edges.slice(0, 200).map((edge) => ({ from: byId.get(edge.sourceId) || edge.sourceId, to: byId.get(edge.targetId) || edge.targetId, evidence: edge.evidence }));
  }, [detail]);
  const files = useMemo(() => detail?.files.filter((file) => file.relativePath.toLowerCase().includes(fileFilter.toLowerCase())) || [], [detail, fileFilter]);
  const selectedFileRecord = detail?.files.find((file) => file.relativePath === selectedFile);
  const selectedSymbols = detail?.symbols.filter((symbol) => symbol.fileId === selectedFileRecord?.id) || [];
  const lines = fileContent.split(/\r?\n/);
  const previewUrl = projectId && previewOutput ? `/api/projects/${encodeURIComponent(projectId)}/preview/${previewToken(previewOutput)}/index.html` : "";

  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="projects-workspace">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <div className="mr-1 flex items-center gap-2"><span className="h-2 w-2 bg-terminal-red"/><span className="font-display text-xs font-semibold uppercase">Project workbench</span></div>
      <select aria-label="Connected project" className="h-8 min-w-48 border bg-background px-2 text-xs" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <Button size="sm" variant="outline" className="h-8" onClick={() => setConnectOpen((value) => !value)}><Plus className="mr-1 h-3.5 w-3.5"/>Connect</Button>
      {detail ? <Button size="sm" variant="outline" className="h-8" onClick={() => void scan()} disabled={busy === "scan"}>{busy === "scan" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin"/> : <RefreshCw className="mr-1 h-3.5 w-3.5"/>}Rescan</Button> : null}
      <span className="ml-auto font-mono text-[10px] text-muted-foreground">read-only · {detail?.files.length || 0} files · {detail?.edges.length || 0} parser edges</span>
    </header>

    {connectOpen ? <div className="grid gap-2 border-b border-border bg-card px-3 py-3 sm:grid-cols-[1fr_auto]"><div><label className="data-label">Absolute project path</label><div className="mt-1 flex gap-1"><input className="h-9 min-w-0 flex-1 border bg-background px-2 text-xs" value={root} onChange={(event) => { setRoot(event.target.value); setConfirmed(false); }} placeholder="C:\\path\\to\\project"/>{getDesktopBridge() ? <Button type="button" variant="outline" onClick={() => void pickProject()}>Browse</Button> : null}</div><label className="mt-2 flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-[var(--terminal-red)]" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/><span>I confirm this trusted local root may be indexed read-only. Secrets, ignored files, vendors, symlinks, and oversized files stay excluded.</span></label></div><Button className="self-end" disabled={!root || !confirmed || busy === "connect"} onClick={() => void connect()}>{busy === "connect" ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <ShieldCheck className="mr-2 h-4 w-4"/>}Connect and scan</Button></div> : null}
    {error ? <p className="border-b border-terminal-red/30 px-3 py-2 text-xs text-terminal-red" role="alert">{error}</p> : null}

    {!detail ? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Connect an explicit TypeScript or JavaScript project to inspect it.</div> :
      <div className="grid min-h-0 flex-1 overflow-auto xl:grid-cols-[240px_minmax(0,1fr)_330px] xl:overflow-hidden">
        <aside className="flex min-h-[260px] flex-col border-b border-border bg-card/40 xl:min-h-0 xl:border-b-0 xl:border-r">
          <div className="grid grid-cols-2 border-b p-1" role="group" aria-label="Repository explorer mode">
            <button type="button" className={`h-7 font-display text-[10px] uppercase ${explorerMode === "files" ? "bg-terminal-red text-white" : "text-muted-foreground"}`} onClick={() => setExplorerMode("files")}><FileCode2 className="mr-1 inline h-3 w-3"/>Files</button>
            <button type="button" className={`h-7 font-display text-[10px] uppercase ${explorerMode === "map" ? "bg-terminal-red text-white" : "text-muted-foreground"}`} onClick={() => setExplorerMode("map")}><Network className="mr-1 inline h-3 w-3"/>Repo map</button>
          </div>
          {explorerMode === "files" ? <><label className="relative border-b"><Search className="absolute left-2 top-2.5 h-3 w-3 text-muted-foreground"/><input aria-label="Filter project files" className="h-8 w-full bg-transparent pl-7 pr-2 font-mono text-[10px] outline-none" value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="filter files"/></label><div className="min-h-0 flex-1 overflow-y-auto">{files.map((file) => <button type="button" key={file.id} onClick={() => void readFile(file.relativePath)} className={`flex w-full items-center gap-2 border-b border-border/60 px-2.5 py-2 text-left font-mono text-[10px] ${selectedFile === file.relativePath ? "border-l-2 border-l-terminal-red bg-terminal-red/5 text-foreground" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"}`}><FileCode2 className={`h-3 w-3 shrink-0 ${selectedFile === file.relativePath ? "text-terminal-red" : ""}`}/><span className="min-w-0 flex-1 truncate">{file.relativePath}</span><span className="text-[9px]">{file.language}</span></button>)}</div>{selectedSymbols.length ? <div className="max-h-36 overflow-y-auto border-t"><p className="data-label px-2.5 py-1.5">Symbols in file</p>{selectedSymbols.map((symbol) => <button key={symbol.id} type="button" className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[10px] hover:bg-muted/40" onClick={() => revealCitation({ path: selectedFile, startLine: symbol.startLine, endLine: symbol.endLine })}><Braces className="h-3 w-3 text-terminal-red"/><span className="min-w-0 flex-1 truncate">{symbol.name}</span><span className="font-mono text-muted-foreground">L{symbol.startLine}</span></button>)}</div> : null}</> : <div className="min-h-0 flex-1 overflow-y-auto p-2.5"><div className="mb-2 flex items-center gap-2"><Network className="h-3.5 w-3.5 text-terminal-red"/><h3 className="font-display text-[10px] uppercase">Parser-derived import structure</h3></div>{graph.length ? graph.map((edge, index) => <div key={`${edge.from}-${edge.to}-${index}`} className="border-t py-2 font-mono text-[9px]"><button className="block max-w-full truncate text-left hover:text-terminal-red" onClick={() => void readFile(edge.from)}>{edge.from}</button><span className="my-0.5 block text-terminal-red">imports ↓</span><button className="block max-w-full truncate text-left text-muted-foreground hover:text-terminal-red" onClick={() => void readFile(edge.to)}>{edge.to}</button></div>) : <p className="text-[10px] text-muted-foreground">No internal TypeScript/JavaScript import edges were found.</p>}</div>}
        </aside>

        <main className="flex min-h-[520px] min-w-0 flex-col border-b border-border xl:min-h-0 xl:border-b-0 xl:border-r">
          <div className="flex min-h-10 items-center gap-2 border-b bg-card/40 px-3">
            <div className="flex border p-0.5" role="group" aria-label="Project result surface"><button type="button" className={`h-7 px-2.5 font-display text-[10px] uppercase ${centerSurface === "source" ? "bg-foreground text-background" : "text-muted-foreground"}`} onClick={() => setCenterSurface("source")}><FileCode2 className="mr-1 inline h-3 w-3"/>Source</button><button type="button" className={`h-7 px-2.5 font-display text-[10px] uppercase ${centerSurface === "preview" ? "bg-foreground text-background" : "text-muted-foreground"}`} onClick={() => setCenterSurface("preview")}><MonitorPlay className="mr-1 inline h-3 w-3"/>Preview</button></div>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{centerSurface === "source" ? selectedFile || "No source selected" : `${detail.project.name}/${previewOutput}/index.html`}</span>
            {centerSurface === "source" && highlight ? <span className="border border-terminal-red/40 px-1.5 py-0.5 font-mono text-[9px] text-terminal-red">L{highlight.startLine}-L{highlight.endLine}</span> : null}
            {centerSurface === "preview" && previewUrl ? <a href={previewUrl} target="_blank" rel="noreferrer" title="Open local preview"><ExternalLink className="h-3.5 w-3.5"/></a> : null}
          </div>
          {centerSurface === "source" ? <div ref={codeScroller} className="min-h-0 flex-1 overflow-auto bg-[hsl(var(--background))] py-3 font-mono text-[11px] leading-5" data-testid="project-source-viewer">{busy === "file" ? <div className="flex h-full items-center justify-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Loading indexed source</div> : fileContent ? lines.map((line, index) => { const lineNumber = index + 1; const active = Boolean(highlight && selectedFile === highlight.path && lineNumber >= highlight.startLine && lineNumber <= highlight.endLine); return <div key={lineNumber} data-source-line={lineNumber} data-highlighted-line={active ? "true" : undefined} className={`grid min-w-max grid-cols-[54px_minmax(0,1fr)] border-l-2 pr-4 ${active ? "border-l-terminal-red bg-terminal-red/10" : "border-l-transparent"}`}><span className={`select-none border-r px-2 text-right ${active ? "text-terminal-red" : "text-muted-foreground/50"}`}>{lineNumber}</span><code className="whitespace-pre pl-4">{line || " "}</code></div>; }) : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Select an indexed file. Content remains local and read-only.</div>}</div> :
            <div className="flex min-h-0 flex-1 flex-col bg-muted/20 p-3" data-testid="project-browser-preview"><div className="flex h-9 items-center gap-2 border border-b-0 bg-background px-2"><div className="flex gap-1"><span className="h-2 w-2 border border-terminal-red/50"/><span className="h-2 w-2 border border-border"/><span className="h-2 w-2 border border-border"/></div><div className="min-w-0 flex-1 truncate border bg-muted/30 px-2 py-1 font-mono text-[9px] text-muted-foreground">local-preview://{detail.project.name}/{previewOutput}</div><span className="font-mono text-[9px] text-terminal-red">isolated</span></div>{previewUrl ? <iframe key={previewUrl} title={`${detail.project.name} local preview`} className="min-h-[430px] flex-1 border bg-white" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" src={previewUrl}/> : <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">Choose an output directory to preview.</div>}</div>}
        </main>

        <aside className="min-h-[520px] overflow-y-auto bg-card/30 xl:min-h-0">
          <section className="p-3">
            <div className="mb-3 flex items-center justify-between gap-2"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-terminal-red"/><div><h3 className="font-display text-xs font-semibold uppercase">Project assistant</h3><p className="text-[10px] text-muted-foreground">Evidence-bound to the connected source.</p></div></div><span className="border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">read only</span></div>
            <textarea aria-label="Ask about this connected project" className="min-h-20 w-full resize-none border bg-background p-2 text-xs outline-none focus:border-terminal-red" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void ask(); }} placeholder="Ask where a behavior lives or what should change..."/>
            <div className="mt-2 flex items-center justify-between gap-2"><button type="button" className="truncate font-mono text-[9px] text-muted-foreground hover:text-terminal-red" onClick={() => setQuestion("Which checks can block this release, and where are they enforced?")}>Try: trace a release blocker</button><Button size="sm" className="h-8 shrink-0" onClick={() => void ask()} disabled={busy === "ask" || !question.trim()}>{busy === "ask" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin"/> : <Search className="mr-1.5 h-3.5 w-3.5"/>}Ask</Button></div>
            {answer ? <div className="mt-4 border-l-2 border-terminal-red pl-3" data-testid="project-source-answer"><div className="mb-2 flex items-center gap-2"><Bot className="h-3.5 w-3.5 text-terminal-red"/><span className="data-label">Source-bounded answer</span></div><SourceAnswer answer={answer} onCitation={revealCitation}/>{citations.length ? <div className="mt-3 flex flex-wrap gap-1">{citations.map((citation) => <button key={citationLabel(citation)} type="button" className="border border-terminal-red/30 px-1.5 py-1 font-mono text-[9px] text-terminal-red hover:bg-terminal-red hover:text-white" onClick={() => revealCitation(citation)}>{citationLabel(citation)}</button>)}</div> : null}</div> : <div className="mt-4 border-y py-3 text-[10px] text-muted-foreground"><p className="font-display uppercase text-foreground">Ask → inspect → deliver</p><p className="mt-1">Answers open their exact source range. Generated static output can then be previewed and shared from this same project.</p></div>}
          </section>

          <section className="border-t p-3">
            <div className="mb-2 flex items-center justify-between"><div><h3 className="font-display text-xs font-semibold uppercase">Change impact</h3><p className="text-[10px] text-muted-foreground">Working tree and affected dependents.</p></div><Button variant="outline" size="sm" className="h-7 px-2" onClick={() => void analyzeImpact()} disabled={busy === "impact"}>{busy === "impact" ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <GitCompareArrows className="h-3.5 w-3.5"/>}<span className="sr-only">Analyze working tree</span></Button></div>
            {impact ? <><div className="grid grid-cols-2 border-y"><div className="p-2"><p className="font-display text-lg text-terminal-red">{impact.changedFiles.length}</p><p className="font-mono text-[9px] text-muted-foreground">direct changes</p></div><div className="border-l p-2"><p className="font-display text-lg">{impact.affectedNodes.length}</p><p className="font-mono text-[9px] text-muted-foreground">dependents</p></div></div>{impact.changedFiles.slice(0,4).map((item) => <button key={item} type="button" className="block w-full truncate border-b py-1.5 text-left font-mono text-[9px] hover:text-terminal-red" onClick={() => detail.files.some((file) => file.relativePath === item) && void readFile(item)}>{item}</button>)}<div className="mt-2 grid grid-cols-2 gap-1"><Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => void confirmedAction("save_impact_notebook")}>Notebook</Button><Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => void confirmedAction("create_impact_task")}>Board task</Button><Link href={`/chat?draft=${encodeURIComponent(`Run a Council architecture and risk review for ${detail.project.name} using impact report ${impact.id}. Changed: ${impact.changedFiles.join(", ")}`)}`}><Button variant="outline" size="sm" className="h-7 w-full text-[10px]">Council</Button></Link><Button size="sm" className="h-7 text-[10px]" disabled={busy === "start_supervised_run"} onClick={() => void confirmedAction("start_supervised_run")}>{busy === "start_supervised_run" ? <Loader2 className="mr-1 h-3 w-3 animate-spin"/> : <ShieldCheck className="mr-1 h-3 w-3"/>}Supervised</Button></div></> : <Button variant="outline" size="sm" className="h-8 w-full" onClick={() => void analyzeImpact()}><GitCompareArrows className="mr-1.5 h-3.5 w-3.5"/>Analyze working tree</Button>}
          </section>
          <ProjectDeploymentPanel project={detail.project} onPreview={(outputPath) => { void openPreview(outputPath); }}/>
        </aside>
      </div>}
  </div>;
}
