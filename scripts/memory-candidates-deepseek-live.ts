#!/usr/bin/env tsx

/**
 * Live, model-backed acceptance for WebChat memory candidates.
 *
 * Run only against an isolated app database with a configured DeepSeek model:
 *   BASE_URL=http://127.0.0.1:3125 pnpm exec tsx scripts/memory-candidates-deepseek-live.ts
 *
 * It proves the production path rather than injecting a candidate directly:
 * an agentic WebChat conversation is reviewed by the model, the proposal stays
 * pending, applying it writes through the scoped atomic memory path, and a
 * fresh WebChat session can recall it.
 */

const BASE_URL = String(process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180_000);
const stamp = Date.now();
const sessionId = `live-candidate-${stamp}`;
const marker = `LIVECANDIDATEPREFERENCE${stamp}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function request(path: string, method = "GET", body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text) as Record<string, any>; } catch { /* keep text for diagnostics */ }
    return { status: response.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function chat(id: string, message: string): Promise<string> {
  const response = await request("/api/channels", "POST", { action: "chat", sessionId: id, message });
  return String(response.json.data?.response || response.json.response || "");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const health = await request("/api/health");
  const modelCheck = (health.json.checks || []).find((entry: { name?: string }) => entry.name === "models");
  check(
    "isolated app uses DeepSeek V4 Flash",
    health.status === 200 && /deepseek-v4-flash/i.test(String(modelCheck?.details || "")),
    String(modelCheck?.details || health.text).slice(0, 180),
  );

  const first = await chat(
    sessionId,
    "Use memory_search to check whether an answer-style preference is already stored. Do not write memory. Reply briefly.",
  );
  check("DeepSeek completes the first agentic WebChat turn", first.length > 0, first.slice(0, 160));

  const second = await chat(
    sessionId,
    `Use memory_search to avoid duplicates before answering. This is a durable preference for future conversations: I prefer concise release notes with a short risk list. Preserve the exact marker ${marker}. Do not call memory_store. Reply briefly.`,
  );
  check("DeepSeek completes the preference turn", second.length > 0, second.slice(0, 160));

  let candidate: Record<string, any> | null = null;
  for (let attempt = 0; attempt < 30 && !candidate; attempt += 1) {
    await sleep(1_000);
    const listed = await request("/api/memory/candidates?status=pending&limit=100&allAgents=1");
    const rows = Array.isArray(listed.json.data) ? listed.json.data as Array<Record<string, any>> : [];
    candidate = rows.find((row) => row.originType === "webchat" && row.sessionId === sessionId) ?? null;
  }

  check("self-learning creates a reviewable WebChat candidate", Boolean(candidate), candidate ? String(candidate.id) : "not created within 30s");
  if (!candidate) {
    console.log(`\nmemory-candidates-deepseek-live: ${passed}/${passed + failed} passed`);
    process.exit(1);
  }

  check("candidate records WebChat provenance and agent scope", candidate.originType === "webchat" && candidate.sessionId === sessionId && candidate.scopeKind === "agent", JSON.stringify({ origin: candidate.originType, scope: candidate.scopeKind }));
  check("candidate is pending before operator application", candidate.status === "pending", String(candidate.status));

  const before = await request(`/api/memory?action=search&query=${encodeURIComponent(marker)}&memoryAccess=agent&agentId=${encodeURIComponent(String(candidate.agentId || "default"))}`);
  const beforeRows = Array.isArray(before.json.data) ? before.json.data as Array<Record<string, any>> : [];
  check("pending candidate is not durable memory", !beforeRows.some((row) => String(row.content || "").includes(marker)), before.text.slice(0, 180));

  const applied = await request("/api/memory/candidates", "POST", { action: "apply", id: candidate.id, resolution: "keep_both" });
  check("operator application succeeds", applied.status === 200 && applied.json.success === true && applied.json.data?.status === "applied", applied.text.slice(0, 180));

  const after = await request(`/api/memory?action=search&query=${encodeURIComponent(marker)}&memoryAccess=agent&agentId=${encodeURIComponent(String(candidate.agentId || "default"))}`);
  const afterRows = Array.isArray(after.json.data) ? after.json.data as Array<Record<string, any>> : [];
  check("applied candidate is retrievable through scoped memory search", afterRows.some((row) => String(row.content || "").includes(marker)), after.text.slice(0, 180));

  const followUp = await chat(
    `live-candidate-recall-${stamp}`,
    `Use memory_search for the exact marker ${marker}. If you find it, reply FOUND. Otherwise reply NOT_FOUND.`,
  );
  check("fresh WebChat session recalls the applied preference", /FOUND/i.test(followUp) && !/NOT_FOUND/i.test(followUp), followUp.slice(0, 240));

  console.log(`\nmemory-candidates-deepseek-live: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
