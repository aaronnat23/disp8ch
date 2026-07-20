export type DesignProjectPlan = {
  productGoal: string;
  primaryUsers: string;
  primaryFlow: string[];
  screens: string[];
  states: string[];
  visualDirection: string;
  responsiveNotes: string;
  accessibilityNotes: string;
  updatedAt: string | null;
};

export type DesignProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  sourceSessionId: string | null;
  activeArtifactId: string | null;
  artifactCount: number;
  plan: DesignProjectPlan;
  createdAt: string;
  updatedAt: string;
};

export type DesignArtifactSummary = {
  id: string;
  projectId: string;
  title: string;
  kind: "html";
  entryFile: string;
  status: string;
  sourceSessionId: string | null;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  createdAt: string;
  updatedAt: string;
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
