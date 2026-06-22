import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const feishuRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const baseUrl = String(context.config.baseUrl || "https://open.feishu.cn/open-apis");
    const hasAppId = Boolean(context.config.appId);
    const lines = [
      "Feishu (Lark) guidance:",
      `- API base URL: ${baseUrl}`,
      `- App credentials: ${hasAppId ? "configured" : "not configured — set appId and appSecretRef in extension settings"}.`,
      "- Auth flow: POST /auth/v3/tenant_access_token/internal → cache token in memory (valid 2h).",
      "- Resource types: docx (documents), file (drive files), folder (drive folders), wiki (knowledge base).",
      "- Always specify the correct resource type in permission and drive API calls.",
    ];
    return lines.join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+feishu\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Feishu (Lark)",
      "Status: active",
      "Skills: feishu-doc, feishu-drive, feishu-perm, feishu-wiki",
      "Auth: tenant access token (POST /auth/v3/tenant_access_token/internal)",
    ].join("\n");
  },
  getStatus() {
    return {
      active: true,
      platform: "feishu-lark",
      skills: ["feishu-doc", "feishu-drive", "feishu-perm", "feishu-wiki"],
    };
  },
};

export default feishuRuntime;
