"use client";

import dynamic from "next/dynamic";

const LoadingFallback = () => (
  <div className="flex items-center justify-center rounded-md border border-dashed p-12">
    <span className="animate-pulse text-sm text-muted-foreground">Loading...</span>
  </div>
);

export const ConfigSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/config-settings").then(
      (mod) => ({ default: mod.ConfigSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const ModelSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/model-settings").then(
      (mod) => ({ default: mod.ModelSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const ChannelSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/channel-settings").then(
      (mod) => ({ default: mod.ChannelSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const VoiceSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/voice-settings").then(
      (mod) => ({ default: mod.VoiceSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const MemorySettingsDynamic = dynamic(
  () =>
    import("@/components/settings/memory-settings").then(
      (mod) => ({ default: mod.MemorySettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const ToolsSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/tools-settings").then(
      (mod) => ({ default: mod.ToolsSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const GeneralSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/general-settings").then(
      (mod) => ({ default: mod.GeneralSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const GoogleSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/google-settings").then(
      (mod) => ({ default: mod.GoogleSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const SecretsSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/secrets-settings").then(
      (mod) => ({ default: mod.SecretsSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const SecuritySettingsDynamic = dynamic(
  () =>
    import("@/components/settings/security-settings").then(
      (mod) => ({ default: mod.SecuritySettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const MCPSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/mcp-settings").then(
      (mod) => ({ default: mod.MCPSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);

export const ConfigValidationSettingsDynamic = dynamic(
  () =>
    import("@/components/settings/config-validation-settings").then(
      (mod) => ({ default: mod.ConfigValidationSettings }),
    ),
  { ssr: false, loading: LoadingFallback },
);
