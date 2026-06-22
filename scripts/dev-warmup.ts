// Dev warmup — touches routes and APIs so next dev doesn't cold-compile on first click.
const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";

const routes = [
  "/", "/chat", "/workflows", "/boards", "/hierarchy", "/council", "/agents", "/activity",
  "/channels", "/documents", "/files", "/scheduler", "/approvals", "/metrics", "/usage",
  "/logs", "/debug", "/maintenance", "/settings", "/docs", "/tags", "/skills", "/extensions", "/memory",
];
const apis = [
  "/api/auth/me", "/api/channels?action=status", "/api/channels?action=sessions",
  "/api/models", "/api/agents", "/api/agents/roles", "/api/workflows",
  "/api/boards", "/api/hierarchy/organizations", "/api/hierarchy/goals",
  "/api/documents?limit=100", "/api/execute/running", "/api/telemetry?action=recent&limit=200",
  "/api/app-shell",
  "/api/chat/bootstrap", "/api/workflows/bootstrap", "/api/boards/bootstrap",
  "/api/hierarchy/bootstrap", "/api/agents/bootstrap", "/api/activity/bootstrap",
  "/api/memory/bootstrap",
  "/api/council/bootstrap", "/api/channels/bootstrap", "/api/documents/bootstrap",
  "/api/scheduler/bootstrap", "/api/approvals/bootstrap",
  "/api/skills/bootstrap", "/api/extensions/bootstrap", "/api/tags/bootstrap",
];

async function warm(url: string) {
  const start = Date.now();
  try {
    await fetch(`${BASE}${url}`);
    console.log(`  ${(Date.now() - start).toString().padStart(4)}ms  ${url}`);
  } catch {
    console.log(`  FAIL    ${url}`);
  }
}

async function main() {
  console.log("Warming routes...");
  for (const r of routes) { await warm(r); }
  console.log("Warming APIs...");
  for (const a of apis) {
    await warm(a);
    await new Promise(r => setTimeout(r, 100));
  }
  console.log("Warmup complete.");
}
main();
