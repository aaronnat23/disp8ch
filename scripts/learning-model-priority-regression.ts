/**
 * Guards background learning model selection.
 *
 * Learning reviews should respect the user's active model priority before
 * optimizing for cost. Otherwise a low-priority local OpenAI-compatible model
 * can be selected simply because it is "free", then fail noisily when the local
 * runtime is not running.
 *
 * Run: pnpm exec tsx scripts/learning-model-priority-regression.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(os.tmpdir(), `disp8ch_learning_model_priority_${Date.now()}.db`);

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const { initializeDatabase, getSqlite } = await import("../src/lib/db");
  const { resolveLearningModel } = await import("../src/lib/learning/loop");
  const { normalizeProviderScopedModelId } = await import("../src/lib/agents/provider-routing");

  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();

  db.prepare("DELETE FROM models").run();
  db.prepare(
    "INSERT INTO models (id, provider, model_id, name, api_key, priority, is_active, base_url, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ).run("local-low", "openai-compatible", "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", "Local Qwen", "local-openai", 2, "http://127.0.0.1:8080/v1", now);
  db.prepare(
    "INSERT INTO models (id, provider, model_id, name, api_key, priority, is_active, base_url, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ).run("deepseek-high", "deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", "sk-test-key", 10, "https://api.deepseek.com", now);

  const primary = resolveLearningModel();
  check("higher-priority provider wins over lower-priority local", primary?.provider === "deepseek", JSON.stringify(primary));
  check("selected model is provider-compatible", primary?.modelId === "deepseek-v4-flash" || primary?.modelId.startsWith("deepseek-"), JSON.stringify(primary));
  check("selected base URL follows the chosen row", primary?.baseUrl === "https://api.deepseek.com", JSON.stringify(primary));

  db.prepare("UPDATE models SET priority = 20 WHERE id = 'local-low'").run();
  const local = resolveLearningModel();
  check("local can still win when user makes it highest priority", local?.provider === "openai-compatible", JSON.stringify(local));
  check("local selection keeps exact model id", local?.modelId === "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", JSON.stringify(local));

  check(
    "direct provider prefix is removed",
    normalizeProviderScopedModelId("deepseek", "deepseek/deepseek-v4-flash") === "deepseek-v4-flash",
  );
  check(
    "third-party catalog namespace is preserved",
    normalizeProviderScopedModelId("openrouter", "deepseek/deepseek-v4-flash") === "deepseek/deepseek-v4-flash",
  );
  const multiProviderSource = fs.readFileSync(path.join(process.cwd(), "src/lib/agents/multi-provider.ts"), "utf8");
  check(
    "normal and streaming chat transports use normalized ids",
    (multiProviderSource.match(/const normalizedModelId = normalizeProviderScopedModelId\(provider, modelId\)/g) || []).length >= 2,
  );
}

main()
  .then(() => {
    console.log(`\nlearning-model-priority-regression: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
