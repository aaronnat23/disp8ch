export type PublishRequest = {
  artifactId: string;
  versionId: string;
  files: Array<{ path: string; content: Buffer; sha256: string; contentType: string }>;
  existingRemoteId?: string;
  existingMetadata?: Record<string, unknown>;
  visibility: "public" | "protected";
  expiresAt?: string;
};

export type PublishResult = {
  provider: string;
  remoteId: string;
  url: string;
  status: "live" | "processing";
  providerMetadata?: Record<string, unknown>;
  oneTimeClaimUrl?: string;
};

export type DeployableSource =
  | { type: "design"; artifactId: string; versionId: string }
  | { type: "project"; projectId: string; outputPath: string };

export type PublishManifest = {
  artifact: { id: string; title: string; sourceType: DeployableSource["type"] };
  version: { id: string };
  files: PublishRequest["files"];
  report: Record<string, unknown>;
  feedbackEnabled: boolean;
};

export interface PublishProvider {
  id: string;
  capabilities: {
    stableUrl: boolean;
    protectedVisibility: boolean;
    expiry: boolean;
    feedback: boolean;
  };
  validateConfiguration(): Promise<{ ok: boolean; reason?: string }>;
  publish(request: PublishRequest): Promise<PublishResult>;
  update(request: PublishRequest): Promise<PublishResult>;
  revoke(remoteId: string, metadata?: Record<string, unknown>): Promise<void>;
}

export type DeploymentStatus = "processing" | "live" | "failed" | "revoked";

export type Deployment = {
  id: string;
  artifactId: string;
  artifactVersionId: string;
  workTrailId: string | null;
  provider: string;
  remoteId: string;
  url: string;
  status: DeploymentStatus;
  visibility: "public" | "protected";
  expiresAt: string | null;
  providerMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  /** Returned once by temporary providers and never persisted. */
  oneTimeClaimUrl?: string;
};

/** Kept for API compatibility with the original Design-only deployment surface. */
export type DesignDeployment = Deployment;

export type DeploymentEvent = {
  id: string;
  deploymentId: string;
  eventType: string;
  fromVersionId: string | null;
  toVersionId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type DeploymentPublishPolicy = {
  deploymentId: string;
  enabled: boolean;
  confirmedAt: string | null;
  confirmedRunId: string | null;
  updatedAt: string;
};

export type DeploymentFeedback = {
  id: string;
  deploymentId: string;
  providerItemId: string;
  submittedAt: string;
  body: string;
  contactRedacted: string | null;
  category: string | null;
  severity: string | null;
  status: "new" | "classified" | "proposed" | "task_created" | "dismissed";
  sourceHash: string;
  boardTaskId: string | null;
  workTrailId: string | null;
  createdAt: string;
  updatedAt: string;
};
