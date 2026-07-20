export type ConnectedProject = {
  id: string;
  name: string;
  canonicalRoot: string;
  readOnly: boolean;
  defaultBranch: string | null;
  languageSummary: Record<string, number>;
  lastScanCommit: string | null;
  lastScanAt: string | null;
  workTrailId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectFile = {
  id: string;
  projectId: string;
  relativePath: string;
  language: string;
  sizeBytes: number;
  contentSha256: string;
  indexedAt: string;
  metadata: { imports?: Array<{ specifier: string; line: number }>; exports?: string[] };
};

export type ProjectSymbol = {
  id: string;
  projectId: string;
  fileId: string;
  symbolType: string;
  name: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  summary: string | null;
  contentSha256: string;
};

export type ProjectEdge = {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  edgeType: "imports" | "exports";
  confidence: number;
  evidence: Record<string, unknown>;
};

export type ProjectImpactReport = {
  id: string;
  projectId: string;
  baseRef: string | null;
  headRef: string | null;
  changedFiles: string[];
  affectedNodes: Array<{ path: string; distance: number; reason: string }>;
  summary: Record<string, unknown>;
  createdAt: string;
};
