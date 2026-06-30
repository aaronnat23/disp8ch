export type DesignPreviewMode = "preview" | "edit" | "comment" | "tweaks" | "draw";

export type DesignEditTarget = {
  id: string;
  kind: string;
  label: string;
  tag: string;
  text: string;
  parentId: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  styles: Record<string, string>;
};

export type PreviewToHost =
  | { type: "disp8ch-design-targets"; targets: DesignEditTarget[] }
  | { type: "disp8ch-design-hover"; target: DesignEditTarget }
  | { type: "disp8ch-design-select"; target: DesignEditTarget }
  | { type: "disp8ch-design-text-commit"; id: string; value: string }
  | { type: "disp8ch-design-console"; level: string; text: string };

export type HostToPreview =
  | { type: "disp8ch-design-mode"; mode: DesignPreviewMode }
  | { type: "disp8ch-design-select"; id: string | null };
