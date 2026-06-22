export type DesignProjectStatus = "active" | "archived";
export type DesignArtifactStatus = "draft" | "published" | "archived";
export type DesignArtifactKind = "html";

export type DesignPatchRecord = {
  id: string;
  artifactId: string;
  versionBeforeId: string | null;
  versionAfterId: string | null;
  patchKind: string;
  label: string;
  patchJson: string;
  source: string;
  sessionId: string | null;
  createdAt: string;
};

export type DesignProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  status: DesignProjectStatus;
  activeArtifactId: string | null;
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DesignArtifactSummary = {
  id: string;
  projectId: string;
  title: string;
  kind: DesignArtifactKind;
  entryFile: string;
  status: DesignArtifactStatus;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DesignArtifactVersion = {
  id: string;
  artifactId: string;
  versionNumber: number;
  sizeBytes: number;
  contentSha256: string;
  summary: string | null;
  createdBy: string;
  createdAt: string;
};

export type DesignArtifactDetail = DesignArtifactSummary & {
  project: DesignProjectSummary | null;
  currentSource: string;
  validation: HtmlValidationResult;
  versions: DesignArtifactVersion[];
  patches?: DesignPatchRecord[];
};

export type DesignProjectDetail = DesignProjectSummary & {
  artifacts: DesignArtifactSummary[];
};

export type CreateDesignProjectInput = {
  name: string;
  description?: string | null;
  organizationId?: string | null;
  goalId?: string | null;
  sourceSessionId?: string | null;
};

export type CreateDesignArtifactInput = {
  projectId?: string | null;
  projectName?: string | null;
  title: string;
  html: string;
  summary?: string | null;
  sourceSessionId?: string | null;
  createdBy?: string;
};

export type SaveDesignArtifactVersionInput = {
  artifactId: string;
  html: string;
  summary?: string | null;
  createdBy?: string;
};

export type HtmlValidationResult = {
  ok: boolean;
  warnings: string[];
  errors: string[];
  stats: {
    chars: number;
    lines: number;
    hasDoctype: boolean;
    hasHtmlTag: boolean;
    hasBodyTag: boolean;
    scriptCount: number;
    externalScriptCount: number;
    externalStylesheetCount: number;
    dataDisp8chIdCount: number;
  };
};

export type DesignValidationReportSummary = {
  id: string;
  artifactId: string;
  versionId: string;
  report: unknown;
  createdAt: string;
};

export type DesignSystemSummary = {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type DesignSystemDetail = DesignSystemSummary & {
  designMd: string;
  tokensCss: string | null;
  componentsHtml: string | null;
  source: unknown;
  extracted: {
    colors: Array<{ name: string; value: string; role?: string }>;
    fonts: Array<{ role: string; stack: string }>;
    radii: string[];
    spacing: string[];
  };
};

export type DesignRecipe = {
  id: string;
  label: string;
  artifactKind: DesignArtifactKind;
  defaultCanvas: string;
  sections: string[];
  qualityChecks: string[];
  body: string;
};
