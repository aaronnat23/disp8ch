/**
 * Capability state source.
 *
 * Checks actual env vars and DB rows to determine which capabilities
 * are implemented, configured, and ready. Used by the /api/capabilities
 * endpoint and by the capability_audit agentic lane to answer questions
 * about what the app can do right now.
 *
 * Rules:
 * - implemented: true if the feature code exists in the codebase
 * - configured: true if required env vars or DB records are present
 * - ready: true only if both implemented AND configured are true
 * - Never claim ready: true when configured: false
 */

export type CapabilitySource = "env" | "db" | "runtime" | "file" | "missing";

export type CapabilityEntry = {
  id: string;
  label: string;
  implemented: boolean;
  configured: boolean;
  ready: boolean;
  source: CapabilitySource;
  reason: string;
  setupPath?: string;
  testAction?: string;
};

export type CapabilityState = {
  capabilities: Record<string, CapabilityEntry>;
  checkedAt: string;
};

function envSet(key: string): boolean {
  const val = process.env[key];
  return typeof val === "string" && val.trim().length > 0;
}

async function checkChannelRowsExist(): Promise<boolean> {
  try {
    const { getSqlite, initializeDatabase } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const row = db.prepare("SELECT id FROM channels LIMIT 1").get();
    return row !== undefined;
  } catch {
    return false;
  }
}

async function checkModelRowsExist(): Promise<boolean> {
  try {
    const { getSqlite, initializeDatabase } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const row = db.prepare("SELECT id FROM models WHERE is_active = 1 LIMIT 1").get();
    return row !== undefined;
  } catch {
    return false;
  }
}

async function checkComputerUse(): Promise<{ implemented: boolean; configured: boolean; ready: boolean; reason: string; source: CapabilitySource }> {
  try {
    const { getComputerUseCapability } = await import("@/lib/computer-use/adapter");
    const cap = await getComputerUseCapability();
    return {
      implemented: cap.implemented,
      configured: cap.configured,
      ready: cap.ready,
      reason: cap.reason,
      source: cap.configured ? "runtime" : "missing",
    };
  } catch {
    return {
      implemented: true,
      configured: false,
      ready: false,
      reason: "Computer use is implemented (beta) but not configured.",
      source: "missing",
    };
  }
}

export async function getCapabilityState(): Promise<CapabilityState> {
  const [channelRowsExist, modelRowsExist, computerUse] = await Promise.all([
    checkChannelRowsExist(),
    checkModelRowsExist(),
    checkComputerUse(),
  ]);

  const browserConfigured =
    envSet("PLAYWRIGHT_WS_ENDPOINT") || envSet("BROWSERBASE_API_KEY");

  const imageConfigured =
    envSet("FAL_API_KEY") || envSet("OPENAI_API_KEY") || envSet("XAI_API_KEY");

  const modelProvidersConfigured =
    modelRowsExist ||
    envSet("OPENAI_API_KEY") ||
    envSet("ANTHROPIC_API_KEY") ||
    envSet("GOOGLE_API_KEY") ||
    envSet("DEEPSEEK_API_KEY") ||
    envSet("XAI_API_KEY") ||
    envSet("FAL_API_KEY");

  const capabilities: Record<string, CapabilityEntry> = {
    browser_automation: {
      id: "browser_automation",
      label: "Browser Automation",
      implemented: true,
      configured: browserConfigured,
      ready: browserConfigured,
      source: browserConfigured ? "env" : "missing",
      reason: browserConfigured
        ? "Browser automation is configured via PLAYWRIGHT_WS_ENDPOINT or BROWSERBASE_API_KEY."
        : "Browser automation requires PLAYWRIGHT_WS_ENDPOINT or BROWSERBASE_API_KEY to be set.",
      setupPath: "/settings",
    },

    computer_use: {
      id: "computer_use",
      label: "Computer Use",
      implemented: computerUse.implemented,
      configured: computerUse.configured,
      ready: computerUse.ready,
      source: computerUse.source,
      reason: computerUse.reason,
      setupPath: "/settings",
      testAction: "Run computer-use status and doctor from Settings → Computer Use.",
    },

    image_generation: {
      id: "image_generation",
      label: "Image Generation",
      implemented: true,
      configured: imageConfigured,
      ready: imageConfigured,
      source: imageConfigured ? "env" : "missing",
      reason: imageConfigured
        ? "Image generation is configured via an API key (FAL, OpenAI, or xAI)."
        : "Image generation requires FAL_API_KEY, OPENAI_API_KEY, or XAI_API_KEY. Without a key, local fallback artifacts are used.",
      setupPath: "/settings/keys",
      testAction: "Generate a test image to verify the configured provider.",
    },

    video_generation: {
      id: "video_generation",
      label: "Video Generation",
      implemented: false,
      configured: false,
      ready: false,
      source: "missing",
      reason: "Video generation is not yet implemented.",
      setupPath: "/settings",
    },

    youtube_transcript: {
      id: "youtube_transcript",
      label: "YouTube Transcript",
      implemented: true,
      configured: true,
      ready: true,
      source: "runtime",
      reason: "YouTube transcript extraction is implemented and available via runtime tools.",
      testAction: "Extract transcript from a public YouTube URL.",
    },

    messaging_channels: {
      id: "messaging_channels",
      label: "Messaging Channels",
      implemented: true,
      configured: channelRowsExist,
      ready: channelRowsExist,
      source: channelRowsExist ? "db" : "missing",
      reason: channelRowsExist
        ? "At least one messaging channel is configured in the database."
        : "No messaging channels are configured yet. Add a channel via the Channels tab.",
      setupPath: "/channels",
    },

    workflow_webhooks: {
      id: "workflow_webhooks",
      label: "Workflow Webhooks",
      implemented: true,
      configured: true,
      ready: true,
      source: "runtime",
      reason: "Webhook automation management and signed execution are implemented and active.",
      testAction: "List webhooks via the Automations tab or webhooks_list tool.",
    },

    cron_scheduling: {
      id: "cron_scheduling",
      label: "Cron Scheduling",
      implemented: true,
      configured: true,
      ready: true,
      source: "runtime",
      reason: "Cron-based workflow scheduling is implemented and active via the Automations tab.",
      testAction: "List schedules via the Automations tab or schedules_list tool.",
    },

    memory_search: {
      id: "memory_search",
      label: "Memory Search",
      implemented: true,
      configured: true,
      ready: true,
      source: "runtime",
      reason: "Memory search is implemented and active. Memories are stored and recalled across sessions.",
    },

    session_recall: {
      id: "session_recall",
      label: "Session Recall",
      implemented: true,
      configured: true,
      ready: true,
      source: "runtime",
      reason: "Session history and recall are implemented and active.",
    },

    file_read_write: {
      id: "file_read_write",
      label: "File Read/Write",
      implemented: true,
      configured: true,
      ready: true,
      source: "runtime",
      reason: "File read/write tools are available in the agentic runtime for workspace operations.",
    },

    model_providers: {
      id: "model_providers",
      label: "Model Providers",
      implemented: true,
      configured: modelProvidersConfigured,
      ready: modelProvidersConfigured,
      source: modelProvidersConfigured ? (modelRowsExist ? "db" : "env") : "missing",
      reason: modelProvidersConfigured
        ? modelRowsExist
          ? "At least one active model row is configured in the database."
          : "A provider API key is set in the environment."
        : "No model provider is configured. Add a model via Settings or set a provider API key.",
      setupPath: "/settings",
      testAction: "Run a test completion to verify the active model.",
    },

    per_agent_model_overrides: {
      id: "per_agent_model_overrides",
      label: "Per-Agent Model Overrides",
      implemented: true,
      configured: true,
      ready: true,
      source: "runtime",
      reason: "Per-agent model overrides (API key, base URL, system prompt, temperature, max tokens) are implemented.",
      setupPath: "/agents",
    },

    skills_extensions: {
      id: "skills_extensions",
      label: "Skills & Extensions",
      implemented: true,
      configured: true,
      ready: true,
      source: "runtime",
      reason: "Skills and extensions system is implemented. Skills can be enabled per-agent or globally.",
      setupPath: "/skills",
    },
  };

  return {
    capabilities,
    checkedAt: new Date().toISOString(),
  };
}
