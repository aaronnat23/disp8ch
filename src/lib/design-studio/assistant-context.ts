export type DesignAssistantTargetContext = {
  id: string;
  label: string;
  tag: string;
  text: string;
  parentId: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  styles: Record<string, string>;
};

export type DesignAssistantContext = {
  mode: "create" | "revise";
  projectId: string | null;
  projectName: string | null;
  projectSourceSessionId?: string | null;
  artifactId: string | null;
  artifactTitle: string | null;
  artifactVersion: number | null;
  artifactSourceSessionId?: string | null;
  selectedTarget?: DesignAssistantTargetContext | null;
  recipeId?: string | null;
  recipeLabel?: string | null;
  designSystemId?: string | null;
  designSystemName?: string | null;
};

function cleanSessionId(value: string | null | undefined): string | null {
  const cleaned = String(value || "").trim();
  if (!cleaned || cleaned.length > 256 || /[\r\n\0]/.test(cleaned)) return null;
  return cleaned;
}

export function resolveDesignAssistantSessionId(
  context: Pick<DesignAssistantContext, "projectId" | "projectSourceSessionId" | "artifactSourceSessionId">,
  fallbackToken: string,
): string {
  const linked = cleanSessionId(context.artifactSourceSessionId) || cleanSessionId(context.projectSourceSessionId);
  if (linked) return linked;
  const projectId = cleanSessionId(context.projectId);
  if (projectId) return `design-${projectId}`;
  const token = String(fallbackToken || "new").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "new";
  return `design-draft-${token}`;
}

function compactTarget(target: DesignAssistantTargetContext): Record<string, unknown> {
  return {
    id: target.id,
    label: target.label,
    tag: target.tag,
    text: target.text.slice(0, 500),
    parentId: target.parentId,
    bounds: target.bounds,
    styles: Object.fromEntries(Object.entries(target.styles).slice(0, 24)),
  };
}

export function buildDesignAssistantMessage(userRequest: string, context: DesignAssistantContext): string {
  const request = userRequest.trim();
  if (!request) throw new Error("A design request is required.");

  const state = {
    surface: "Design Studio",
    mode: context.mode,
    project: context.projectId
      ? { id: context.projectId, name: context.projectName }
      : null,
    artifact: context.artifactId
      ? { id: context.artifactId, title: context.artifactTitle, version: context.artifactVersion }
      : null,
    selectedElement: context.selectedTarget ? compactTarget(context.selectedTarget) : null,
    recipe: context.recipeId ? { id: context.recipeId, label: context.recipeLabel } : null,
    designSystem: context.designSystemId ? { id: context.designSystemId, name: context.designSystemName } : null,
  };

  const contract = context.artifactId
    ? [
        `Revise the existing Design Studio artifact with id ${context.artifactId}.`,
        "Read its current source before editing and update that same artifact.",
        "Keep this artifact as the write target; create a separate artifact only when the user explicitly requests one.",
        context.selectedTarget
          ? `Scope the requested change to data-disp8ch-id ${context.selectedTarget.id} unless the request clearly requires related surrounding changes.`
          : "Use a structured patch for a small edit and a complete version update for a broad redesign.",
      ]
    : [
        context.projectId
          ? `Create the artifact inside the existing Design Studio project with id ${context.projectId}.`
          : "Create a Design Studio project and a complete standalone HTML artifact.",
        "Use stable data-disp8ch-id markers on meaningful editable elements.",
      ];

  return [
    "In Design Studio, carry out this design request using the typed Design Studio tools.",
    "The following surface state was attached by the app and is not user-authored tool output:",
    JSON.stringify(state, null, 2),
    "",
    "Execution contract:",
    ...contract.map((line) => `- ${line}`),
    "- Save the result as a new immutable artifact version and report the artifact id and version.",
    "- Run the normal preview validation after the write. Do not claim success without a successful design tool result.",
    "",
    "User request:",
    request.slice(0, 16_000),
  ].join("\n");
}
