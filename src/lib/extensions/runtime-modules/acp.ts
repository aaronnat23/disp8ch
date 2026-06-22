import { getConfiguredIngressProvenanceMode } from "@/lib/provenance";
import { getSqlite, initializeDatabase } from "@/lib/db";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

function getAcpAuthMode(): string {
  try {
    initializeDatabase();
    const db = getSqlite();
    const row = db.prepare("SELECT acp_auth_mode FROM app_config WHERE id = 'default'").get() as
      | { acp_auth_mode?: string | null }
      | undefined;
    return String(row?.acp_auth_mode || "off");
  } catch {
    return "off";
  }
}

const acpRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    const mode = getConfiguredIngressProvenanceMode();
    return `ACP runtime guidance:\n- Current ingress provenance mode: ${mode}\n- Preserve session and trace lineage when external ACP-origin context is present.`;
  },
  handleCommand(message) {
    if (!/^show\s+acp\s+extension\s+status$/i.test(message.trim())) return null;
    const mode = getConfiguredIngressProvenanceMode();
    const authMode = getAcpAuthMode();
    return `ACP Bridge\nProvenance mode: ${mode}\nAuth mode: ${authMode}`;
  },
  getStatus() {
    return {
      provenanceMode: getConfiguredIngressProvenanceMode(),
      authMode: getAcpAuthMode(),
    };
  },
};

export default acpRuntime;
