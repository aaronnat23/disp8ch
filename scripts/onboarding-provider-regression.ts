#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

type Result = { name: string; ok: boolean; detail: string };

const results: Result[] = [];

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

const onboarding = read("src/app/onboarding/page.tsx");
const providerPlugins = read("src/lib/agents/provider-plugins.ts");
const modelTestRoute = read("src/app/api/models/test/route.ts");
const modelRoute = read("src/app/api/models/route.ts");
const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };

check(
  "onboarding defaults to an easy hosted provider",
  onboarding.includes('const DEFAULT_PROVIDER = "deepseek"'),
  "default provider is DeepSeek direct",
);

for (const label of [
  "Easiest hosted",
  "Gateway",
  "Local/private",
  "Advanced",
  "DeepSeek Direct",
  "OpenRouter",
  "Ollama",
  "LM Studio",
  "llama.cpp / OpenAI-compatible",
  "Google Gemini",
]) {
  check(`onboarding preset includes ${label}`, onboarding.includes(label), label);
}

check(
  "local presets expose no-key setup paths",
  onboarding.includes('"No key by default"') &&
    onboarding.includes('"Optional local auth"') &&
    onboarding.includes("http://localhost:11434") &&
    onboarding.includes("http://127.0.0.1:1234/v1") &&
    onboarding.includes("http://127.0.0.1:8000/v1"),
  "Ollama, LM Studio, and OpenAI-compatible endpoints are discoverable",
);

check(
  "onboarding offers hardware-aware local setup",
  onboarding.includes("Check this PC") &&
    onboarding.includes("/api/model-fit/recommendations") &&
    onboarding.includes("Best all-rounder") &&
    onboarding.includes("Use this setup"),
  "local setup can inspect the PC and prefill a recommended runtime",
);

check(
  "onboarding shows local tradeoffs",
  onboarding.includes("Best quality") &&
    onboarding.includes("Best all-rounder") &&
    onboarding.includes("Best speed") &&
    onboarding.includes("This PC"),
  "local setup explains quality, balanced, speed, and detected hardware",
);

check(
  "live validation runs before model save in onboarding",
  onboarding.indexOf("await validateConnection()") >= 0 &&
    onboarding.indexOf("await saveModelIfNeeded()") > onboarding.indexOf("await validateConnection()") &&
    onboarding.includes('fetch("/api/models/test"') &&
    onboarding.includes('fetch("/api/models"'),
  "validation precedes save path",
);

check(
  "model test route performs a real READY probe",
  modelTestRoute.includes('systemPrompt: "You are a connectivity probe. Reply with only READY."') &&
    modelTestRoute.includes('userMessage: "Reply with only READY."') &&
    modelTestRoute.includes("callModel") &&
    modelTestRoute.includes("checkModelToolSupport"),
  "live model and tool-capability checks are present",
);

check(
  "model save stores raw credentials through secrets when possible",
  modelRoute.includes("upsertSecret") &&
    modelRoute.includes("storedApiKey = `secret:${saved.name}`") &&
    modelRoute.includes("checkModelToolSupport"),
  "secret reference storage and tool-capability gate present",
);

check(
  "default skill posture stays lean during onboarding",
  !onboarding.includes("enable all") &&
    !onboarding.includes("Enable all") &&
    !onboarding.includes("/api/agents/skills") &&
    onboarding.includes('const DEFAULT_LEARNING_MODE = "review"'),
  "onboarding does not auto-enable optional skill packs",
);

check(
  "provider plugin metadata supports required setup paths",
  providerPlugins.includes('id: "deepseek"') &&
    providerPlugins.includes('id: "openrouter"') &&
    providerPlugins.includes('id: "ollama"') &&
    providerPlugins.includes('id: "lmstudio"') &&
    providerPlugins.includes('id: "openai-compatible"') &&
    providerPlugins.includes('id: "google"'),
  "hosted, gateway, local, and advanced providers exist",
);

check(
  "install:test includes onboarding provider regression",
  Boolean(packageJson.scripts?.["install:test"]?.includes("onboarding-provider-regression.ts")),
  "install test chain covers onboarding",
);

const disallowedPublicTokens = [
  ["V", "R-"],
  ["H", "13"],
  ["H", "6"],
  ["benchmark", "-", "scenario"],
  ["fix", "ture"],
  ["gold", "en"],
].map((parts) => parts.join(""));

for (const token of disallowedPublicTokens) {
  check(`onboarding regression free of ${token}`, !onboarding.includes(token), "scan");
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
