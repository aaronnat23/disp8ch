import { appendWorkTrailEvent, getWorkTrail, listWorkTrails } from "@/lib/work-trails/work-trails";
import { buildPublishManifest, decodeProjectArtifactId } from "./gate";
import { getPublishProvider, listPublishProviders } from "./providers";
import { createDeployment, getDeployment, getDeploymentPublishPolicy, listDeploymentEvents, listDeployments, listEnabledDeploymentPolicies, recordDeploymentEvent, revokeDeploymentRecord, setDeploymentPublishPolicy, updateDeployment } from "./store";
import type { DeployableSource, DesignDeployment } from "./types";
import { resolveSecretValue } from "@/lib/secrets/store";
import { getDesignArtifactById } from "@/lib/design-studio/store";
import { getConnectedProject } from "@/lib/projects/store";
import { getDynamicWorkflowRun } from "@/lib/dynamic-workflows/store";
import { auditAcceptance } from "@/lib/dynamic-workflows/criteria";

function normalizeSource(input: { source?: DeployableSource; artifactId?: string; versionId?: string }): DeployableSource {
  if (input.source) return input.source;
  if (!input.artifactId || !input.versionId) throw new Error("A deployable source is required.");
  return decodeProjectArtifactId(input.artifactId) || { type: "design", artifactId: input.artifactId, versionId: input.versionId };
}

function resolvePublishProvenance(input: {
  source: DeployableSource;
  requestedWorkTrailId?: string | null;
  requestedRunId?: string | null;
}): { workTrailId: string | null; supervisedRunId: string | null } {
  let derivedTrailId: string | null = null;
  if (input.source.type === "project") {
    derivedTrailId = getConnectedProject(input.source.projectId)?.workTrailId ?? null;
  } else {
    const sessionId = getDesignArtifactById(input.source.artifactId)?.sourceSessionId;
    derivedTrailId = sessionId ? listWorkTrails({ sessionId, limit: 1 })[0]?.id ?? null : null;
  }
  const workTrailId = derivedTrailId || input.requestedWorkTrailId || null;
  if (input.requestedWorkTrailId && derivedTrailId && input.requestedWorkTrailId !== derivedTrailId) {
    throw new Error("Publishing blocked because the supplied Work Trail does not own this artifact.");
  }
  const trail = workTrailId ? getWorkTrail(workTrailId) : null;
  const linkedRunId = trail?.events
    .filter((event) => event.objectType === "dynamic-run" && event.objectId && event.eventType.startsWith("supervised_run_"))
    .at(-1)?.objectId ?? null;
  const supervisedRunId = linkedRunId || input.requestedRunId || null;
  if (input.requestedRunId) {
    const run = getDynamicWorkflowRun(input.requestedRunId);
    if (!run) throw new Error("Publishing blocked because the supplied supervised run does not exist.");
    if (workTrailId && run.workTrailId && run.workTrailId !== workTrailId) {
      throw new Error("Publishing blocked because the supervised run belongs to a different Work Trail.");
    }
    if (linkedRunId && linkedRunId !== input.requestedRunId) {
      throw new Error("Publishing blocked because the supplied run is not the latest supervised run for this artifact trail.");
    }
  }
  return { workTrailId, supervisedRunId };
}

function safeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  const allowed = ["projectName", "deploymentUrl"];
  return Object.fromEntries(allowed.filter((key) => typeof value[key] === "string").map((key) => [key, String(value[key]).slice(0, 1000)]));
}

export async function listProviderStatus() {
  return Promise.all(listPublishProviders().map(async (item) => {
    const provider = getPublishProvider(item.id)!;
    const feedbackConfigured = Boolean(
      (resolveSecretValue("DISP8CH_FEEDBACK_SUBMIT_URL") || process.env.DISP8CH_FEEDBACK_SUBMIT_URL) &&
      (resolveSecretValue("DISP8CH_FEEDBACK_FEED_URL") || process.env.DISP8CH_FEEDBACK_FEED_URL),
    );
    return { ...item, capabilities: { ...item.capabilities, feedback: feedbackConfigured }, configuration: await provider.validateConfiguration(), feedbackConfigured };
  }));
}

export function getArtifactDeployments(artifactId: string) {
  return listDeployments(artifactId).map((deployment) => ({
    ...deployment,
    events: listDeploymentEvents(deployment.id),
    autoPublishPolicy: getDeploymentPublishPolicy(deployment.id),
  }));
}

export async function publishArtifact(input: {
  artifactId?: string;
  versionId?: string;
  source?: DeployableSource;
  providerId: string;
  visibility: "public" | "protected";
  expiresAt?: string | null;
  workTrailId?: string | null;
  supervisedRunId?: string | null;
}): Promise<DesignDeployment> {
  const provider = getPublishProvider(input.providerId);
  if (!provider) throw new Error(`Unknown publish provider: ${input.providerId}`);
  const configured = await provider.validateConfiguration();
  if (!configured.ok) throw new Error(configured.reason || "Publish provider is not configured.");
  if (input.visibility === "protected" && !provider.capabilities.protectedVisibility) throw new Error("This provider does not support protected visibility.");
  if (input.expiresAt && !provider.capabilities.expiry) throw new Error("This provider does not support deployment expiry.");
  const source = normalizeSource(input);
  const provenance = resolvePublishProvenance({ source, requestedWorkTrailId: input.workTrailId, requestedRunId: input.supervisedRunId });
  const manifest = await buildPublishManifest({ source, supervisedRunId: provenance.supervisedRunId });
  const result = await provider.publish({
    artifactId: manifest.artifact.id,
    versionId: manifest.version.id,
    files: manifest.files,
    visibility: input.visibility,
    expiresAt: input.expiresAt ?? undefined,
  });
  const oneTimeClaimUrl = result.oneTimeClaimUrl;
  result.providerMetadata = safeMetadata(result.providerMetadata);
  const deployment = createDeployment({
    artifactId: manifest.artifact.id,
    versionId: manifest.version.id,
    workTrailId: provenance.workTrailId,
    result,
    visibility: input.visibility,
    expiresAt: input.expiresAt,
  });
  if (provenance.workTrailId) appendWorkTrailEvent({ trailId: provenance.workTrailId, eventType: "deployment_created", surface: "deployments", objectType: "deployment", objectId: deployment.id, objectName: manifest.artifact.title, summary: deployment.url, metadata: { supervisedRunId: provenance.supervisedRunId, versionId: manifest.version.id } });
  return oneTimeClaimUrl ? { ...deployment, oneTimeClaimUrl } : deployment;
}

export async function updateArtifactDeployment(input: {
  deploymentId: string;
  versionId: string;
  action: "update" | "rollback";
  supervisedRunId?: string | null;
}): Promise<DesignDeployment> {
  const deployment = getDeployment(input.deploymentId);
  if (!deployment) throw new Error("Deployment not found.");
  if (deployment.status === "revoked") throw new Error("A revoked deployment cannot be updated.");
  if (input.versionId === deployment.artifactVersionId && input.action === "update") return deployment;
  const provider = getPublishProvider(deployment.provider);
  if (!provider) throw new Error("The deployment provider is unavailable.");
  const source = normalizeSource({ artifactId: deployment.artifactId, versionId: input.versionId });
  const provenance = resolvePublishProvenance({ source, requestedWorkTrailId: deployment.workTrailId, requestedRunId: input.supervisedRunId });
  const manifest = await buildPublishManifest({ source, supervisedRunId: provenance.supervisedRunId });
  let result;
  try {
    result = await provider.update({
      artifactId: deployment.artifactId,
      versionId: manifest.version.id,
      files: manifest.files,
      existingRemoteId: deployment.remoteId,
      existingMetadata: deployment.providerMetadata,
      visibility: deployment.visibility,
      expiresAt: deployment.expiresAt ?? undefined,
    });
  } catch (error) {
    recordDeploymentEvent({ deploymentId: deployment.id, eventType: "update_failed", fromVersionId: deployment.artifactVersionId, toVersionId: manifest.version.id, summary: String(error).replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 1000) });
    throw error;
  }
  result.providerMetadata = safeMetadata(result.providerMetadata);
  const oneTimeClaimUrl = result.oneTimeClaimUrl;
  const updated = updateDeployment({ deployment, result, versionId: manifest.version.id, eventType: input.action === "rollback" ? "rolled_back" : "updated" });
  if (deployment.workTrailId) appendWorkTrailEvent({ trailId: deployment.workTrailId, eventType: input.action === "rollback" ? "deployment_rolled_back" : "deployment_updated", surface: "deployments", objectType: "deployment", objectId: deployment.id, summary: `Version ${manifest.version.id}` });
  return oneTimeClaimUrl ? { ...updated, oneTimeClaimUrl } : updated;
}

export function configureAutoPublish(input: { deploymentId: string; enabled: boolean; confirmed: true }) {
  const deployment = getDeployment(input.deploymentId);
  if (!deployment) throw new Error("Deployment not found.");
  if (!input.enabled) return setDeploymentPublishPolicy({ deploymentId: deployment.id, enabled: false });
  if (!deployment.workTrailId) throw new Error("Auto-publish requires a deployment linked to a Work Trail.");
  const trail = getWorkTrail(deployment.workTrailId);
  const runId = trail?.events
    .filter((event) => event.objectType === "dynamic-run" && event.eventType === "supervised_run_completed" && event.objectId)
    .at(-1)?.objectId;
  if (!runId || !auditAcceptance(runId).passed) throw new Error("Auto-publish can only be enabled after a passed supervised run on this Work Trail.");
  const policy = setDeploymentPublishPolicy({ deploymentId: deployment.id, enabled: true, confirmedRunId: runId });
  recordDeploymentEvent({ deploymentId: deployment.id, eventType: "auto_publish_enabled", fromVersionId: deployment.artifactVersionId, toVersionId: deployment.artifactVersionId, summary: `Auto-publish confirmed after supervised run ${runId}` });
  return policy;
}

export async function processAutoPublishForCompletedRun(runId: string, workTrailId: string): Promise<void> {
  if (!auditAcceptance(runId).passed) return;
  for (const { deployment } of listEnabledDeploymentPolicies(workTrailId)) {
    try {
      if (deployment.artifactId.startsWith("project:")) {
        await updateArtifactDeployment({ deploymentId: deployment.id, versionId: deployment.artifactVersionId, action: "rollback", supervisedRunId: runId });
      } else {
        const artifact = getDesignArtifactById(deployment.artifactId);
        if (!artifact?.currentVersionId || artifact.currentVersionId === deployment.artifactVersionId) continue;
        await updateArtifactDeployment({ deploymentId: deployment.id, versionId: artifact.currentVersionId, action: "update", supervisedRunId: runId });
      }
      recordDeploymentEvent({ deploymentId: deployment.id, eventType: "auto_publish_completed", fromVersionId: deployment.artifactVersionId, summary: `Updated after supervised run ${runId}` });
    } catch (error) {
      recordDeploymentEvent({ deploymentId: deployment.id, eventType: "auto_publish_blocked", fromVersionId: deployment.artifactVersionId, summary: `Gates preserved the live version: ${String(error).slice(0, 700)}` });
    }
  }
}

export async function revokeArtifactDeployment(deploymentId: string): Promise<DesignDeployment> {
  const deployment = getDeployment(deploymentId);
  if (!deployment) throw new Error("Deployment not found.");
  if (deployment.status === "revoked") return deployment;
  const provider = getPublishProvider(deployment.provider);
  if (!provider) throw new Error("The deployment provider is unavailable.");
  await provider.revoke(deployment.remoteId, deployment.providerMetadata);
  const revoked = revokeDeploymentRecord(deployment);
  if (deployment.workTrailId) appendWorkTrailEvent({ trailId: deployment.workTrailId, eventType: "deployment_revoked", surface: "deployments", objectType: "deployment", objectId: deployment.id, summary: deployment.url });
  return revoked;
}
