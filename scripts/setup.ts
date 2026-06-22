import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { PROVIDERS } from "../src/types/model";
import { normalizeProviderBaseUrl } from "../src/lib/agents/provider-base-url";
import {
  getProviderBaseUrlEnvKey,
  getProviderWizardMeta,
  providerAllowsOptionalApiKey,
  providerSupportsDynamicCatalog,
  providerSupportsBaseUrlInput,
  providerSupportsCredentialInput,
  resolveProviderModelSelection,
} from "../src/lib/agents/provider-plugins";

const PROVIDER_PLACEHOLDERS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-...",
  OPENAI_API_KEY: "sk-...",
  GOOGLE_API_KEY: "AIza...",
  OPENCODE_API_KEY: "sk-opencode-...",
  GROQ_API_KEY: "gsk_...",
  TOGETHER_API_KEY: "your-together-key",
  OPENROUTER_API_KEY: "sk-or-...",
  DEEPSEEK_API_KEY: "sk-...",
  MISTRAL_API_KEY: "your-mistral-key",
  ZHIPU_API_KEY: "your-zhipu-key",
  MOONSHOT_API_KEY: "sk-...",
  QWEN_API_KEY: "sk-...",
  XAI_API_KEY: "xai-...",
  VLLM_API_KEY: "vllm-local",
  SGLANG_API_KEY: "sglang-local",
};

const ENCRYPTION_PREFIX = "v1:";

function readEnvValueFromText(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
}

function upsertEnvLines(
  existingText: string,
  desired: Array<{ key: string; value: string; overwrite?: boolean }>,
): string {
  const lines = existingText ? existingText.split(/\r?\n/) : [];
  const lineMap = new Map<string, number>();

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([A-Z0-9_]+)=/);
    if (match) lineMap.set(match[1], i);
  }

  for (const entry of desired) {
    const line = `${entry.key}=${entry.value}`;
    const index = lineMap.get(entry.key);
    if (index === undefined) {
      lines.push(line);
      lineMap.set(entry.key, lines.length - 1);
      continue;
    }

    const currentValue = lines[index].slice(entry.key.length + 1).trim();
    if (entry.overwrite || !currentValue) {
      lines[index] = line;
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

function encryptSecretForSetup(plainText: string, hexKey: string): string {
  const key = Buffer.from(hexKey, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return `${ENCRYPTION_PREFIX}${payload}`;
}

async function main() {
  p.intro("Welcome to disp8ch setup!");

  // 1. Check prerequisites
  const s = p.spinner();
  s.start("Checking prerequisites...");

  const nodeVersion = process.version;
  const nodeMinor = parseInt(nodeVersion.split(".")[0].replace("v", ""), 10);

  let dockerAvailable = false;
  try {
    execFileSync("docker", ["info"], { stdio: "pipe" });
    dockerAvailable = true;
  } catch {
    // Docker not available
  }

  s.stop("Prerequisites checked");

  p.log.success(`Node.js ${nodeVersion} ${nodeMinor >= 22 ? "(OK)" : "(warning: v22.13+ recommended)"}`);
  p.log.success("pnpm (OK — you're running this script)");
  if (dockerAvailable) {
    p.log.success("Docker available");
  } else {
    p.log.info("Docker not found (optional)");
  }

  // 2. Prompt for model providers and API keys
  const selectedProviders: string[] = [];
  while (true) {
    const remainingProviders = PROVIDERS.filter(
      (provider) => !selectedProviders.includes(provider.id)
    );

    const providerChoice = await p.select({
      message:
        selectedProviders.length === 0
          ? "Select a model provider to configure:"
          : "Select another provider to configure:",
      options: remainingProviders.map((provider) => ({
        value: provider.id,
        label: getProviderWizardMeta(provider.id)?.onboarding?.choiceLabel || provider.name,
        hint:
          getProviderWizardMeta(provider.id)?.onboarding?.choiceHint ||
          (provider.requiresApiKey ? "API key required" : "No key required (local)"),
      })),
    });

    if (p.isCancel(providerChoice)) {
      p.cancel("Setup cancelled");
      process.exit(0);
    }

    selectedProviders.push(providerChoice as string);

    if (selectedProviders.length === PROVIDERS.length) {
      break;
    }

    const configureAnother = await p.confirm({
      message: "Configure another provider now?",
      initialValue: false,
    });

    if (p.isCancel(configureAnother)) {
      p.cancel("Setup cancelled");
      process.exit(0);
    }

    if (!configureAnother) {
      break;
    }
  }

  const envKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENCODE_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "ZHIPU_API_KEY",
    "MOONSHOT_API_KEY",
    "QWEN_API_KEY",
    "QWEN_BASE_URL",
    "XAI_API_KEY",
    "OLLAMA_BASE_URL",
    "VLLM_API_KEY",
    "VLLM_BASE_URL",
    "SGLANG_API_KEY",
    "SGLANG_BASE_URL",
  ] as const;

  const providerEnvValues: Record<(typeof envKeys)[number], string> = {
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    OPENCODE_API_KEY: "",
    GROQ_API_KEY: "",
    TOGETHER_API_KEY: "",
    OPENROUTER_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    MISTRAL_API_KEY: "",
    ZHIPU_API_KEY: "",
    MOONSHOT_API_KEY: "",
    QWEN_API_KEY: "",
    QWEN_BASE_URL: "",
    XAI_API_KEY: "",
    OLLAMA_BASE_URL: "",
    VLLM_API_KEY: "",
    VLLM_BASE_URL: "",
    SGLANG_API_KEY: "",
    SGLANG_BASE_URL: "",
  };

  for (const providerId of selectedProviders) {
    const provider = PROVIDERS.find((pInfo) => pInfo.id === providerId);
    if (!provider) continue;
    const wizard = getProviderWizardMeta(provider.id);
    const supportsCredentialInput = providerSupportsCredentialInput(provider.id);
    const supportsBaseUrlInput = providerSupportsBaseUrlInput(provider.id);

    if (supportsCredentialInput && !supportsBaseUrlInput) {
      const key = await p.text({
        message: wizard?.onboarding?.credential?.label
          ? `${wizard.onboarding.credential.label}:`
          : `Enter your ${provider.name} API key:`,
        placeholder:
          wizard?.onboarding?.credential?.placeholder ||
          PROVIDER_PLACEHOLDERS[provider.envKey] ||
          "your-api-key",
        validate: (value) => {
          if (provider.requiresApiKey && (!value || value.length < 10)) {
            return "Please enter a valid API key";
          }
          if (!provider.requiresApiKey && value && value.length < 4) {
            return "API key looks too short";
          }
          return undefined;
        },
      });

      if (p.isCancel(key)) {
        p.cancel("Setup cancelled");
        process.exit(0);
      }

      providerEnvValues[provider.envKey as keyof typeof providerEnvValues] = key as string;
      continue;
    }

    if (supportsBaseUrlInput) {
      const localBaseUrl = await p.text({
        message: wizard?.onboarding?.baseUrl?.label
          ? `${wizard.onboarding.baseUrl.label}:`
          : `${provider.name} base URL:`,
        placeholder:
          wizard?.onboarding?.baseUrl?.placeholder ||
          provider.baseUrl ||
          "http://localhost:11434",
        defaultValue:
          normalizeProviderBaseUrl(provider.id, provider.baseUrl) ||
          provider.baseUrl ||
          "http://localhost:11434",
        validate: (value) => {
          if (!value) return "Please enter a URL";
          try {
            const url = new URL(value);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              return "URL must start with http:// or https://";
            }
            return undefined;
          } catch {
            return "Please enter a valid URL";
          }
        },
      });

      if (p.isCancel(localBaseUrl)) {
        p.cancel("Setup cancelled");
        process.exit(0);
      }

      const normalizedLocalBaseUrl =
        normalizeProviderBaseUrl(provider.id, localBaseUrl as string) ||
        normalizeProviderBaseUrl(provider.id, provider.baseUrl) ||
        "";
      const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider.id);
      if (baseUrlEnvKey) {
        providerEnvValues[baseUrlEnvKey as keyof typeof providerEnvValues] = normalizedLocalBaseUrl;
      }

      if (supportsCredentialInput) {
        const key = await p.text({
          message: wizard?.onboarding?.credential?.label
            ? `${wizard.onboarding.credential.label}${providerAllowsOptionalApiKey(provider.id) ? " (optional)" : ""}:`
            : `Enter your ${provider.name} API key${providerAllowsOptionalApiKey(provider.id) ? " (optional)" : ""}:`,
          placeholder:
            wizard?.onboarding?.credential?.placeholder ||
            PROVIDER_PLACEHOLDERS[provider.envKey] ||
            "your-api-key",
          validate: (value) => {
            if (provider.requiresApiKey && (!value || value.length < 10)) {
              return "Please enter a valid API key";
            }
            if (value && value.length < 4) return "API key looks too short";
            return undefined;
          },
        });
        if (p.isCancel(key)) {
          p.cancel("Setup cancelled");
          process.exit(0);
        }
        providerEnvValues[provider.envKey as keyof typeof providerEnvValues] = key as string;
      }
    }
  }

  // 3. Create directories
  s.start("Setting up directories...");

  const projectRoot = process.cwd();
  const dataDir = path.join(projectRoot, "data");
  const memoriesDir = path.join(dataDir, "memories");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(memoriesDir, { recursive: true });

  s.stop("Directories created");

  // 4. Reuse the existing encryption key when setup is re-run so stored secrets remain decryptable.
  const envPath = path.join(projectRoot, ".env.local");
  const existingEnvText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const encryptionKey =
    readEnvValueFromText(existingEnvText, "ENCRYPTION_KEY") ||
    readEnvValueFromText(existingEnvText, "SECRETS_MASTER_KEY") ||
    crypto.randomBytes(32).toString("hex");

  // 5. Write .env.local
  s.start("Creating .env.local...");

  const envContent = upsertEnvLines(existingEnvText, [
    { key: "ANTHROPIC_API_KEY", value: providerEnvValues.ANTHROPIC_API_KEY, overwrite: Boolean(providerEnvValues.ANTHROPIC_API_KEY) },
    { key: "OPENAI_API_KEY", value: providerEnvValues.OPENAI_API_KEY, overwrite: Boolean(providerEnvValues.OPENAI_API_KEY) },
    { key: "GOOGLE_API_KEY", value: providerEnvValues.GOOGLE_API_KEY, overwrite: Boolean(providerEnvValues.GOOGLE_API_KEY) },
    { key: "OPENCODE_API_KEY", value: providerEnvValues.OPENCODE_API_KEY, overwrite: Boolean(providerEnvValues.OPENCODE_API_KEY) },
    { key: "GROQ_API_KEY", value: providerEnvValues.GROQ_API_KEY, overwrite: Boolean(providerEnvValues.GROQ_API_KEY) },
    { key: "TOGETHER_API_KEY", value: providerEnvValues.TOGETHER_API_KEY, overwrite: Boolean(providerEnvValues.TOGETHER_API_KEY) },
    { key: "OPENROUTER_API_KEY", value: providerEnvValues.OPENROUTER_API_KEY, overwrite: Boolean(providerEnvValues.OPENROUTER_API_KEY) },
    { key: "DEEPSEEK_API_KEY", value: providerEnvValues.DEEPSEEK_API_KEY, overwrite: Boolean(providerEnvValues.DEEPSEEK_API_KEY) },
    { key: "MISTRAL_API_KEY", value: providerEnvValues.MISTRAL_API_KEY, overwrite: Boolean(providerEnvValues.MISTRAL_API_KEY) },
    { key: "ZHIPU_API_KEY", value: providerEnvValues.ZHIPU_API_KEY, overwrite: Boolean(providerEnvValues.ZHIPU_API_KEY) },
    { key: "MOONSHOT_API_KEY", value: providerEnvValues.MOONSHOT_API_KEY, overwrite: Boolean(providerEnvValues.MOONSHOT_API_KEY) },
    { key: "QWEN_API_KEY", value: providerEnvValues.QWEN_API_KEY, overwrite: Boolean(providerEnvValues.QWEN_API_KEY) },
    { key: "QWEN_BASE_URL", value: providerEnvValues.QWEN_BASE_URL, overwrite: Boolean(providerEnvValues.QWEN_BASE_URL) },
    { key: "XAI_API_KEY", value: providerEnvValues.XAI_API_KEY, overwrite: Boolean(providerEnvValues.XAI_API_KEY) },
    { key: "OLLAMA_BASE_URL", value: providerEnvValues.OLLAMA_BASE_URL, overwrite: Boolean(providerEnvValues.OLLAMA_BASE_URL) },
    { key: "VLLM_API_KEY", value: providerEnvValues.VLLM_API_KEY, overwrite: Boolean(providerEnvValues.VLLM_API_KEY) },
    { key: "VLLM_BASE_URL", value: providerEnvValues.VLLM_BASE_URL, overwrite: Boolean(providerEnvValues.VLLM_BASE_URL) },
    { key: "SGLANG_API_KEY", value: providerEnvValues.SGLANG_API_KEY, overwrite: Boolean(providerEnvValues.SGLANG_API_KEY) },
    { key: "SGLANG_BASE_URL", value: providerEnvValues.SGLANG_BASE_URL, overwrite: Boolean(providerEnvValues.SGLANG_BASE_URL) },
    { key: "TELEGRAM_BOT_TOKEN", value: "" },
    { key: "DISCORD_BOT_TOKEN", value: "" },
    { key: "WHATSAPP_AUTO_CONNECT", value: "false" },
    { key: "WS_PORT", value: "3101" },
    { key: "DATABASE_PATH", value: "./data/disp8ch.db" },
    { key: "MEMORY_PATH", value: "./data/memories" },
    { key: "ENCRYPTION_KEY", value: encryptionKey, overwrite: !readEnvValueFromText(existingEnvText, "SECRETS_MASTER_KEY") },
  ]);

  fs.writeFileSync(envPath, envContent, "utf-8");
  s.stop(".env.local created");
  const selectedProviderNames = selectedProviders
    .map((providerId) => PROVIDERS.find((pInfo) => pInfo.id === providerId)?.name)
    .filter((name): name is string => Boolean(name));
  p.log.success(`Configured providers: ${selectedProviderNames.join(", ")}`);

  // 6. Initialize database
  s.start("Setting up database...");

  // Import and initialize
  try {
    // Set env before import
    process.env.DATABASE_PATH = "./data/disp8ch.db";
    process.env.MEMORY_PATH = "./data/memories";

    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.resolve(dataDir, "disp8ch.db");
    const db = new Database(dbPath);
    db.pragma(process.platform === "win32" ? "journal_mode = DELETE" : "journal_mode = WAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        nodes TEXT NOT NULL,
        edges TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_data TEXT,
        node_results TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        is_active INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        max_tokens INTEGER,
        base_url TEXT,
        fast_mode INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
        CREATE TABLE IF NOT EXISTS app_config (
          id TEXT PRIMARY KEY,
          onboarding_done INTEGER DEFAULT 0,
          timezone TEXT DEFAULT 'UTC',
          lane_main_max_concurrent INTEGER DEFAULT 4,
          lane_cron_max_concurrent INTEGER DEFAULT 1,
          lane_subflow_max_concurrent INTEGER DEFAULT 8,
          install_posture TEXT DEFAULT 'local_only',
          disable_loopback_bypass INTEGER DEFAULT 0,
          operator_auth_backoff_enabled INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      CREATE TABLE IF NOT EXISTS memory_config (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        auto_threshold INTEGER DEFAULT 50,
        total_memories INTEGER DEFAULT 0,
        storage_bytes INTEGER DEFAULT 0,
        embedding_model TEXT DEFAULT 'local',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_secrets (
        name TEXT PRIMARY KEY,
        value_enc TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id, content, tags, type
      );
    `);

    const now = new Date().toISOString();

    const upsertSecret = db.prepare(`
      INSERT INTO app_secrets (name, value_enc, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        value_enc = excluded.value_enc,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);

    // Seed app_config
    const existing = db.prepare("SELECT id FROM app_config WHERE id = 'default'").get();
    if (!existing) {
      db.prepare(
        "INSERT INTO app_config (id, onboarding_done, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run("default", 0, "UTC", now, now);
    }

    // Seed memory_config
    const memExisting = db.prepare("SELECT id FROM memory_config WHERE id = 'default'").get();
    if (!memExisting) {
      db.prepare(
        "INSERT INTO memory_config (id, tier, auto_threshold, total_memories, storage_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("default", "auto", 50, 0, 0, now);
    }

    // Ensure base_url column exists on older databases
    try {
      db.prepare("SELECT base_url FROM models LIMIT 0").get();
    } catch {
      db.exec("ALTER TABLE models ADD COLUMN base_url TEXT");
    }
    try {
      db.prepare("SELECT fast_mode FROM models LIMIT 0").get();
    } catch {
      db.exec("ALTER TABLE models ADD COLUMN fast_mode INTEGER DEFAULT 0");
    }

    // Ensure newer app_config columns exist on older databases
    try {
      const appCols = db.prepare("PRAGMA table_info(app_config)").all() as Array<{ name: string }>;
      const names = new Set(appCols.map((c) => c.name));
      if (!names.has("lane_main_max_concurrent"))
        db.exec("ALTER TABLE app_config ADD COLUMN lane_main_max_concurrent INTEGER DEFAULT 4");
      if (!names.has("lane_cron_max_concurrent"))
        db.exec("ALTER TABLE app_config ADD COLUMN lane_cron_max_concurrent INTEGER DEFAULT 1");
      if (!names.has("lane_subflow_max_concurrent"))
        db.exec("ALTER TABLE app_config ADD COLUMN lane_subflow_max_concurrent INTEGER DEFAULT 8");
      if (!names.has("install_posture"))
        db.exec("ALTER TABLE app_config ADD COLUMN install_posture TEXT DEFAULT 'local_only'");
      if (!names.has("disable_loopback_bypass"))
        db.exec("ALTER TABLE app_config ADD COLUMN disable_loopback_bypass INTEGER DEFAULT 0");
      if (!names.has("operator_auth_backoff_enabled"))
        db.exec("ALTER TABLE app_config ADD COLUMN operator_auth_backoff_enabled INTEGER DEFAULT 1");
    } catch {
      // best-effort
    }

    // Seed/update selected providers into models table so they appear in Settings
    const existingProviderRows = db.prepare("SELECT provider FROM models").all() as Array<{ provider: string }>;
    const existingProviders = new Set(existingProviderRows.map((r) => r.provider));
    let priority = (
      db.prepare("SELECT COUNT(*) as count FROM models").get() as { count: number }
    ).count;

    const insertModel = db.prepare(
      "INSERT INTO models (id, provider, model_id, name, api_key, priority, is_active, max_tokens, base_url, fast_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const updateModel = db.prepare(
      "UPDATE models SET api_key = ?, base_url = ?, fast_mode = 0, is_active = 1 WHERE provider = ?"
    );

    let insertedModels = 0;
    let updatedModels = 0;

    for (const providerId of selectedProviders) {
      const providerInfo = PROVIDERS.find((pInfo) => pInfo.id === providerId);
      if (!providerInfo) continue;

      const envKey = providerInfo.envKey as keyof typeof providerEnvValues;
      const rawApiKey = providerSupportsCredentialInput(providerId)
        ? providerEnvValues[envKey] || ""
        : "";
      const apiKey = rawApiKey ? `secret:${String(providerInfo.envKey)}` : "";
      if (rawApiKey) {
        const encrypted = encryptSecretForSetup(rawApiKey, encryptionKey);
        upsertSecret.run(String(providerInfo.envKey), encrypted, "setup-wizard", now, now);
      }
      const baseUrlEnvKey = getProviderBaseUrlEnvKey(providerId);
      const baseUrl =
        normalizeProviderBaseUrl(
          providerId,
          (baseUrlEnvKey ? providerEnvValues[baseUrlEnvKey as keyof typeof providerEnvValues] : undefined) || providerInfo.baseUrl,
        ) || null;
      const selection = await resolveProviderModelSelection({
        provider: providerId,
        baseUrl,
        apiKey: rawApiKey,
      });
      const modelIdToStore = selection.modelId || providerInfo.defaultModel;
      const modelNameToStore = selection.name || providerInfo.defaultName;
      if (selection.discovered) {
        p.log.info(`Discovered ${providerId} model: ${modelIdToStore}`);
      } else if (providerSupportsDynamicCatalog(providerId)) {
        p.log.info(`Could not auto-discover ${providerId} models, using the default model id.`);
      }
      for (const warning of selection.warnings) {
        p.log.info(warning);
      }

      if (existingProviders.has(providerId)) {
        updateModel.run(apiKey, baseUrl, providerId);
        updatedModels += 1;
        continue;
      }

      const modelId = crypto.randomBytes(8).toString("hex").slice(0, 8);
      insertModel.run(
        modelId,
        providerId,
        modelIdToStore,
        modelNameToStore,
        apiKey,
        priority,
        1,
        null,
        baseUrl,
        0,
        now
      );
      priority += 1;
      insertedModels += 1;
    }

    if (insertedModels > 0 || updatedModels > 0) {
      p.log.success(`Model config synced: ${insertedModels} added, ${updatedModels} updated`);
    }

    db.close();
    s.stop("Database initialized (9 tables + FTS)");
  } catch (error) {
    s.stop("Database setup failed");
    p.log.error(`Database error: ${String(error)}`);
  }

  // 7. Register dpc CLI globally
  const registerCli = await p.confirm({
    message: "Register 'dpc' as a global CLI command? (so you can run 'dpc' directly)",
    initialValue: true,
  });

  if (!p.isCancel(registerCli) && registerCli) {
    s.start("Registering dpc CLI...");
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("npm", ["link"], { cwd: projectRoot, stdio: "pipe" });
      s.stop("dpc CLI registered globally");
      p.log.success("You can now run 'dpc' from anywhere");
    } catch {
      s.stop("Could not register globally");
      p.log.info("You can still use: npx dpc <command> or pnpm dpc <command>");
    }
  } else {
    p.log.info("CLI available via: npx dpc <command> or pnpm dpc <command>");
  }

  // 8. Success
  p.outro(
    "Setup complete! If disp8ch is not already running, start it with 'pnpm dev'.\n" +
      "  → http://localhost:3100\n" +
      "  → CLI: dpc help"
  );
}

main().catch((error) => {
  console.error("Setup failed:", error);
  process.exit(1);
});
