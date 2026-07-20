"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clipboard, ExternalLink, Globe2, Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DesignArtifactSummary } from "@/components/design-studio/types";
import type { DesignArtifactVersion } from "@/lib/design-studio/types";
import type { DeploymentFeedback, DesignDeployment } from "@/lib/publishing/types";

type ProviderStatus = {
  id: string;
  capabilities: { stableUrl: boolean; protectedVisibility: boolean; expiry: boolean; feedback: boolean };
  configuration: { ok: boolean; reason?: string };
  feedbackConfigured?: boolean;
};

type DeploymentWithEvents = DesignDeployment & { events: Array<{ id: string; eventType: string; summary: string; createdAt: string }>; autoPublishPolicy?: { enabled: boolean } | null };

export function DeploymentPanel({
  artifact,
  open,
  onOpenChange,
}: {
  artifact: DesignArtifactSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [deployments, setDeployments] = useState<DeploymentWithEvents[]>([]);
  const [versions, setVersions] = useState<DesignArtifactVersion[]>([]);
  const [providerId, setProviderId] = useState("cloudflare-temporary");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ error?: boolean; text: string } | null>(null);
  const [rollbackVersions, setRollbackVersions] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, DeploymentFeedback[]>>({});

  const load = useCallback(async () => {
    const [deploymentResponse, artifactResponse] = await Promise.all([
      fetch(`/api/design/deployments?artifactId=${encodeURIComponent(artifact.id)}`),
      fetch(`/api/design/artifacts/${encodeURIComponent(artifact.id)}`),
    ]);
    const deploymentJson = await deploymentResponse.json();
    const artifactJson = await artifactResponse.json();
    if (!deploymentJson.success) throw new Error(deploymentJson.error || "Could not load deployments.");
    if (!artifactJson.success) throw new Error(artifactJson.error || "Could not load artifact versions.");
    setProviders(deploymentJson.data.providers || []);
    const loadedDeployments = deploymentJson.data.deployments || [];
    setDeployments(loadedDeployments);
    setVersions(artifactJson.data.versions || []);
    const feedbackEntries = await Promise.all(loadedDeployments.map(async (deployment: DeploymentWithEvents) => {
      const response = await fetch(`/api/design/deployments/${encodeURIComponent(deployment.id)}/feedback`);
      const json = await response.json();
      return [deployment.id, json.success ? json.data || [] : []] as const;
    }));
    setFeedback(Object.fromEntries(feedbackEntries));
  }, [artifact.id]);

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    void load().catch((error) => setNotice({ error: true, text: String(error) }));
  }, [load, open]);

  const provider = providers.find((candidate) => candidate.id === providerId);
  const currentVersion = useMemo(
    () => versions.find((version) => version.id === artifact.currentVersionId) || versions[0],
    [artifact.currentVersionId, versions],
  );

  const validate = async () => {
    setBusy("validate");
    setNotice(null);
    try {
      const response = await fetch(`/api/design/artifacts/${encodeURIComponent(artifact.id)}/check`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visual: true }),
      });
      const json = await response.json();
      if (!json.success || json.data?.ok !== true) throw new Error(json.error || json.data?.failures?.join(" ") || "Validation failed.");
      setNotice({ text: "Desktop and mobile publish checks passed." });
    } catch (error) {
      setNotice({ error: true, text: String(error) });
    } finally {
      setBusy("");
    }
  };

  const publish = async () => {
    if (!currentVersion || !confirmed) return;
    setBusy("publish");
    setNotice(null);
    try {
      const response = await fetch("/api/design/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId: artifact.id, versionId: currentVersion.id, providerId, visibility: "public", confirmed: true }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
      setConfirmed(false);
      setNotice({ text: json.data.oneTimeClaimUrl ? `Published ${currentVersion.id}. Claim link: ${json.data.oneTimeClaimUrl}` : `Published ${currentVersion.id}.` });
      await load();
    } catch (error) {
      setNotice({ error: true, text: String(error) });
    } finally {
      setBusy("");
    }
  };

  const action = async (deployment: DeploymentWithEvents, actionName: "update" | "rollback" | "revoke") => {
    const versionId = actionName === "rollback" ? rollbackVersions[deployment.id] : currentVersion?.id;
    if (actionName !== "revoke" && !versionId) return;
    const confirmation = actionName === "revoke"
      ? "Revoke this public URL?"
      : `${actionName} deployment to ${versionId}?`;
    if (!window.confirm(confirmation)) return;
    setBusy(`${actionName}:${deployment.id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/design/deployments/${encodeURIComponent(deployment.id)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(actionName === "revoke" ? { action: "revoke", confirmed: true } : { action: actionName, versionId, confirmed: true }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
      setNotice({ text: `Deployment ${actionName} completed.` });
      await load();
    } catch (error) {
      setNotice({ error: true, text: String(error) });
    } finally {
      setBusy("");
    }
  };

  const feedbackAction = async (deployment: DeploymentWithEvents, actionName: "sync" | "create_task" | "start_revision", feedbackId?: string) => {
    if (actionName === "create_task" && !window.confirm("Create a linked Board task from this untrusted feedback entry?")) return;
    if (actionName === "start_revision" && !window.confirm("Generate a bounded plan and start one supervised revision from this untrusted feedback? Publishing will still require a separate confirmation.")) return;
    setBusy(`${actionName}:${deployment.id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/design/deployments/${encodeURIComponent(deployment.id)}/feedback`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(actionName === "sync" ? { action: "sync" } : { action: actionName, feedbackId, confirmed: true }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
      setNotice({ text: actionName === "sync" ? `Feedback synced; ${json.data.inserted} new entries.` : actionName === "create_task" ? "Board task created from feedback." : `Supervised revision ${json.data.id} started.` });
      await load();
    } catch (error) { setNotice({ error: true, text: String(error) }); }
    finally { setBusy(""); }
  };

  const toggleAutoPublish = async (deployment: DeploymentWithEvents) => {
    const enabled = !deployment.autoPublishPolicy?.enabled;
    if (enabled && !window.confirm("Enable automatic updates for this deployment only after later supervised runs on the same Work Trail pass every publish gate?")) return;
    if (!enabled && !window.confirm("Disable automatic updates for this deployment?")) return;
    setBusy(`auto:${deployment.id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/design/deployments/${encodeURIComponent(deployment.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "auto_publish", enabled, confirmed: true }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
      setNotice({ text: enabled ? "Auto-publish policy recorded for passed supervised runs." : "Auto-publish disabled." });
      await load();
    } catch (error) { setNotice({ error: true, text: String(error) }); }
    finally { setBusy(""); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display uppercase">Publish {artifact.title}</DialogTitle>
          <DialogDescription>Only the selected immutable version is uploaded. Disp8ch itself and local files remain private.</DialogDescription>
        </DialogHeader>

        <section className="space-y-3 border-y border-border py-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="space-y-1"><span className="data-label">Provider</span><select className="h-9 w-full border bg-background px-2 text-sm" value={providerId} onChange={(event) => setProviderId(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
            <Button variant="outline" className="self-end" onClick={() => void validate()} disabled={busy === "validate"}>{busy === "validate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}Run publish checks</Button>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <div><span className="data-label">Version</span><p className="font-mono">{currentVersion ? `v${currentVersion.versionNumber} · ${currentVersion.id}` : "none"}</p></div>
            <div><span className="data-label">Visibility</span><p>Public</p></div>
            <div><span className="data-label">Provider status</span><p className={provider?.configuration.ok ? "text-foreground" : "text-terminal-red"}>{provider?.configuration.ok ? "ready" : provider?.configuration.reason || "checking"}</p></div>
          </div>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-[var(--terminal-red)]" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm publishing this exact version as a public website. No automatic publishing is enabled.</span></label>
          <div className="flex justify-end"><Button onClick={() => void publish()} disabled={!confirmed || !currentVersion || !provider?.configuration.ok || busy === "publish"}><Globe2 className="mr-2 h-4 w-4" />{busy === "publish" ? "Publishing" : "Publish version"}</Button></div>
        </section>

        {notice ? <p className={`border-l-2 pl-2 text-xs ${notice.error ? "border-terminal-red text-terminal-red" : "border-terminal-red/50"}`} role="status">{notice.text}</p> : null}

        <section className="space-y-2">
          <div className="flex items-center justify-between"><h3 className="font-display text-sm uppercase">Deployment history</h3><button type="button" title="Refresh deployments" onClick={() => void load()}><RefreshCw className="h-4 w-4" /></button></div>
          {deployments.length === 0 ? <p className="text-xs text-muted-foreground">No deployments for this artifact.</p> : deployments.map((deployment) => (
            <div key={deployment.id} className="border-y border-border py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div><div className="flex items-center gap-2"><span className={`h-2 w-2 ${deployment.status === "live" ? "bg-terminal-red" : "bg-muted-foreground"}`} /><span className="font-medium">{deployment.status}</span><span className="font-mono text-[10px] text-muted-foreground">{deployment.artifactVersionId}</span></div><a href={deployment.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-terminal-red hover:underline">{deployment.url}<ExternalLink className="h-3 w-3" /></a></div>
                <div className="flex gap-1"><button type="button" title="Copy public URL" className="border p-1.5" onClick={() => void navigator.clipboard.writeText(deployment.url)}><Clipboard className="h-3.5 w-3.5" /></button>{deployment.status !== "revoked" ? <><button type="button" title={deployment.autoPublishPolicy?.enabled ? "Disable supervised auto-publish" : "Enable supervised auto-publish"} className={`border px-2 font-mono text-[10px] ${deployment.autoPublishPolicy?.enabled ? "border-terminal-red text-terminal-red" : ""}`} onClick={() => void toggleAutoPublish(deployment)}>auto</button><button type="button" title="Update to current version" className="border p-1.5" onClick={() => void action(deployment, "update")}><RefreshCw className="h-3.5 w-3.5" /></button><button type="button" title="Revoke deployment" className="border p-1.5 text-terminal-red" onClick={() => void action(deployment, "revoke")}><Trash2 className="h-3.5 w-3.5" /></button></> : null}</div>
              </div>
              {deployment.status !== "revoked" && versions.length > 1 ? <div className="mt-2 flex items-center gap-2"><select className="h-8 border bg-background px-2 font-mono text-xs" value={rollbackVersions[deployment.id] || ""} onChange={(event) => setRollbackVersions((current) => ({ ...current, [deployment.id]: event.target.value }))}><option value="">Select prior version</option>{versions.filter((version) => version.id !== deployment.artifactVersionId).map((version) => <option key={version.id} value={version.id}>v{version.versionNumber} · {version.id}</option>)}</select><Button size="sm" variant="outline" disabled={!rollbackVersions[deployment.id] || busy.startsWith("rollback:")} onClick={() => void action(deployment, "rollback")}><RotateCcw className="mr-1 h-3 w-3" />Rollback</Button></div> : null}
              {deployment.events.length > 0 ? <div className="mt-2 font-mono text-[10px] text-muted-foreground">{deployment.events.slice(0, 3).map((event) => <div key={event.id}>{new Date(event.createdAt).toLocaleString()} · {event.summary}</div>)}</div> : null}
              {deployment.status !== "revoked" ? <div className="mt-3 border-t border-border/60 pt-2"><div className="flex flex-wrap items-center justify-between gap-2"><span className="data-label">Public feedback</span><div className="flex gap-1">{providers.find((item) => item.id === deployment.provider)?.feedbackConfigured ? <a href={`${deployment.url.replace(/\/$/, "")}/feedback.html`} target="_blank" rel="noreferrer"><Button size="sm" variant="outline">Open feedback page</Button></a> : null}<Button size="sm" variant="outline" disabled={!providers.find((item) => item.id === deployment.provider)?.capabilities.feedback || busy === `sync:${deployment.id}`} title={providers.find((item) => item.id === deployment.provider)?.capabilities.feedback ? "Sync provider feedback" : "Configure DISP8CH_FEEDBACK_SUBMIT_URL and DISP8CH_FEEDBACK_FEED_URL"} onClick={() => void feedbackAction(deployment, "sync")}>{busy === `sync:${deployment.id}` ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}Sync feedback</Button></div></div>{(feedback[deployment.id] || []).map((item) => <div key={item.id} className="mt-2 border-l-2 border-terminal-red/40 pl-2 text-xs"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[10px]">{item.category}/{item.severity}</span><span className="text-muted-foreground">{new Date(item.submittedAt).toLocaleString()}</span></div><p className="mt-1">{item.body}</p><div className="mt-1 flex flex-wrap gap-1">{item.boardTaskId ? <p className="font-mono text-[10px]">Board task: {item.boardTaskId}</p> : <Button size="sm" variant="outline" onClick={() => void feedbackAction(deployment, "create_task", item.id)}>Create Board task</Button>}<Button size="sm" variant="outline" onClick={() => void feedbackAction(deployment, "start_revision", item.id)}>Start supervised revision</Button></div></div>)}</div> : null}
            </div>
          ))}
        </section>
      </DialogContent>
    </Dialog>
  );
}
