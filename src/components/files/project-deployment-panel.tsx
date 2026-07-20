"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Clipboard, ExternalLink, Globe2, Loader2, MonitorPlay, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectedProject } from "@/lib/projects/types";
import type { DesignDeployment } from "@/lib/publishing/types";

type Provider = { id: string; configuration: { ok: boolean; reason?: string }; capabilities: { feedback: boolean } };
type DeploymentWithEvents = DesignDeployment & { events: Array<{ id: string; summary: string; createdAt: string }> };

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }

export function ProjectDeploymentPanel({ project, onPreview }: { project: ConnectedProject; onPreview?: (outputPath: string) => void }) {
  const [outputPath, setOutputPath] = useState("dist");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("cloudflare-temporary");
  const [deployments, setDeployments] = useState<DeploymentWithEvents[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<{ error?: boolean; text: string; claimUrl?: string } | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/publishing?projectId=${encodeURIComponent(project.id)}&outputPath=${encodeURIComponent(outputPath)}`);
    const json = await response.json();
    if (!json.success) throw new Error(message(json.error));
    setProviders(json.data.providers || []);
    setDeployments(json.data.deployments || []);
  }, [outputPath, project.id]);
  useEffect(() => { void load().catch((error) => setNotice({ error: true, text: message(error) })); }, [load]);
  const provider = providers.find((item) => item.id === providerId);

  const publish = async () => {
    if (!confirmed) return;
    setBusy("publish"); setNotice(null);
    try {
      const response = await fetch("/api/publishing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: { type: "project", projectId: project.id, outputPath }, providerId, visibility: "public", workTrailId: project.workTrailId, confirmed: true }) });
      const json = await response.json();
      if (!json.success) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
      setConfirmed(false);
      setNotice({ text: `Published verified bundle ${json.data.artifactVersionId}.`, claimUrl: json.data.oneTimeClaimUrl });
      await load();
    } catch (error) { setNotice({ error: true, text: message(error) }); }
    finally { setBusy(""); }
  };

  const action = async (deployment: DeploymentWithEvents, name: "update" | "revoke") => {
    if (!window.confirm(name === "revoke" ? "Revoke this public URL?" : `Rebuild the manifest from ${outputPath}, rerun all gates, and update this URL?`)) return;
    setBusy(`${name}:${deployment.id}`); setNotice(null);
    try {
      const response = await fetch(`/api/publishing/${encodeURIComponent(deployment.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: name, confirmed: true }) });
      const json = await response.json();
      if (!json.success) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
      setNotice({ text: name === "update" ? `Updated to ${json.data.artifactVersionId}.` : "Deployment revoked.", claimUrl: json.data.oneTimeClaimUrl });
      await load();
    } catch (error) { setNotice({ error: true, text: message(error) }); }
    finally { setBusy(""); }
  };

  return <section className="border-t border-border bg-background/70 px-3 py-3" data-testid="project-publish-panel">
    <div className="mb-3 flex items-center justify-between gap-2">
      <div><h3 className="font-display text-xs font-semibold uppercase">Build &amp; share</h3><p className="text-[10px] text-muted-foreground">Preview locally, then publish the same verified output.</p></div>
      <span className="border border-terminal-red/40 px-1.5 py-0.5 font-mono text-[9px] text-terminal-red">confirmation gated</span>
    </div>
    <label><span className="data-label">Static output directory</span><input className="mt-1 h-8 w-full border bg-background px-2 font-mono text-[11px]" value={outputPath} onChange={(event) => { setOutputPath(event.target.value); setConfirmed(false); }} placeholder="dist" /></label>
    <div className="mt-2 grid grid-cols-2 gap-2">
      <Button variant="outline" size="sm" className="h-8" disabled={!outputPath.trim()} onClick={() => onPreview?.(outputPath.trim())}><MonitorPlay className="mr-1.5 h-3.5 w-3.5" />Preview</Button>
      <select aria-label="Publish provider" className="h-8 min-w-0 border bg-background px-2 font-mono text-[10px]" value={providerId} onChange={(event) => setProviderId(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select>
    </div>
    <p className={`mt-1 text-[10px] ${provider?.configuration.ok ? "text-muted-foreground" : "text-terminal-red"}`}>{provider?.configuration.ok ? "provider ready" : provider?.configuration.reason || "checking provider"}</p>
    <label className="mt-3 flex items-start gap-2 text-[10px] leading-4"><input type="checkbox" className="mt-0.5 accent-[var(--terminal-red)]" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm this project-relative static output may be published publicly after path, symlink, secret, size, and HTML checks. Cloudflare temporary publishing accepts Cloudflare&apos;s terms and returns a one-time claim link that expires in 60 minutes.</span></label>
    <Button className="mt-3 h-8 w-full" size="sm" disabled={!confirmed || !outputPath.trim() || !provider?.configuration.ok || busy === "publish"} onClick={() => void publish()}>{busy === "publish" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Globe2 className="mr-2 h-4 w-4" />}Publish verified output</Button>
    {notice ? <div className={`mt-3 border-l-2 pl-2 text-xs ${notice.error ? "border-terminal-red text-terminal-red" : "border-terminal-red/50"}`} role="status"><p>{notice.text}</p>{notice.claimUrl ? <p className="mt-1"><a className="text-terminal-red underline" href={notice.claimUrl} target="_blank" rel="noreferrer">Claim this Cloudflare preview within 60 minutes</a>. This secret link is shown once and is not saved by Disp8ch.</p> : null}</div> : null}
    <button type="button" className="mt-3 flex w-full items-center justify-between border-t pt-2 text-left font-display text-[10px] uppercase" onClick={() => setHistoryOpen((value) => !value)}><span>Deployment history · {deployments.length}</span>{historyOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</button>
    {historyOpen ? <div>{deployments.length ? deployments.map((deployment) => <div key={deployment.id} className="mt-2 border-t pt-2 text-[10px]"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate font-mono">{deployment.artifactVersionId}</p><a className="inline-flex max-w-full items-center gap-1 truncate text-terminal-red" href={deployment.url} target="_blank" rel="noreferrer">{deployment.url}<ExternalLink className="h-3 w-3 shrink-0" /></a></div><div className="flex shrink-0 gap-1"><button type="button" className="border p-1" title="Copy URL" onClick={() => void navigator.clipboard.writeText(deployment.url)}><Clipboard className="h-3 w-3" /></button>{deployment.status !== "revoked" ? <><button type="button" className="border p-1" title="Update deployment" onClick={() => void action(deployment, "update")}><RefreshCw className="h-3 w-3" /></button><button type="button" className="border p-1 text-terminal-red" title="Revoke deployment" onClick={() => void action(deployment, "revoke")}><Trash2 className="h-3 w-3" /></button></> : null}</div></div></div>) : <p className="mt-2 text-[10px] text-muted-foreground">No deployments for this project output.</p>}</div> : null}
  </section>;
}
