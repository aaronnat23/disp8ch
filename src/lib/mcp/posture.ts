import { getSqlite, initializeDatabase } from "@/lib/db";
import type { MCPApprovalMode } from "@/lib/mcp/client";

/**
 * Global MCP security posture, chosen by the operator in Settings.
 *
 *  - "open":    execute in-scope MCP calls directly, no approval prompts
 *               (fast, trusting). The per-agent allowlist still applies —
 *               posture controls APPROVAL, never SCOPE.
 *  - "guarded": honor each tool's configured approval mode (off/human/model).
 *               This is the safe default.
 *  - "strict":  any non-read-only MCP call requires human approval, regardless
 *               of per-tool config; read-only tools follow their configured mode.
 *
 * Posture only ever narrows or relaxes the APPROVAL requirement. It can never
 * grant an agent access to a server it is not allow-listed for.
 */
export type McpSecurityPosture = "open" | "guarded" | "strict";

export const DEFAULT_MCP_POSTURE: McpSecurityPosture = "guarded";

export function getMcpSecurityPosture(): McpSecurityPosture {
  try {
    initializeDatabase();
    const row = getSqlite()
      .prepare("SELECT mcp_security_posture FROM app_config WHERE id = 'default'")
      .get() as { mcp_security_posture?: string | null } | undefined;
    const raw = String(row?.mcp_security_posture || DEFAULT_MCP_POSTURE).trim().toLowerCase();
    return raw === "open" || raw === "strict" || raw === "guarded" ? (raw as McpSecurityPosture) : DEFAULT_MCP_POSTURE;
  } catch {
    return DEFAULT_MCP_POSTURE;
  }
}

/**
 * Resolve the EFFECTIVE approval mode for an in-scope MCP tool call, given the
 * tool's configured mode, its read-only flag, and the global posture.
 * Pure + testable.
 */
export function resolveEffectiveApprovalMode(
  configuredMode: MCPApprovalMode,
  readonly: boolean | null,
  posture: McpSecurityPosture,
): MCPApprovalMode {
  if (posture === "open") return "off";
  if (posture === "strict") {
    // Non-read-only (write/unknown) always requires a human; read-only keeps its mode.
    if (readonly !== true) return "human";
    return configuredMode;
  }
  // guarded
  return configuredMode;
}
