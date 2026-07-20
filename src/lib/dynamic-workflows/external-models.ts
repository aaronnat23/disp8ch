import type { DynamicWorkflowAgentKind } from "./types";

export const CODEX_OAUTH_PROVIDER = "codex-oauth";
export const CODEX_OAUTH_DEFAULT_MODEL = "gpt-5.6-terra";
export const CODEX_OAUTH_MODEL_REF = `${CODEX_OAUTH_PROVIDER}:${CODEX_OAUTH_DEFAULT_MODEL}`;

export type ExternalModelRef = {
  agentKind: Exclude<DynamicWorkflowAgentKind, "internal">;
  provider: string;
  modelId: string;
};

export function parseExternalModelRef(modelRef: string | null | undefined): ExternalModelRef | null {
  const value = String(modelRef || "").trim();
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const provider = value.slice(0, separator).toLowerCase();
  const modelId = value.slice(separator + 1).trim();
  if (provider === CODEX_OAUTH_PROVIDER && modelId) {
    return { agentKind: "codex", provider, modelId };
  }
  return null;
}
