/**
 * Workflow memory visibility regression (temp DB + temp memory dir, no model).
 *
 * Proves workflow-scoped memory is isolated from unrelated workflows by default,
 * agent-scoped memory is shared only by explicit choice, a different agent can
 * recall neither, scope is enforced before ranking, and "no durable memory"
 * startup excludes the agent-wide MEMORY.md.
 *
 * Run: pnpm exec tsx scripts/workflow-memory-scope-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_wf_memscope_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "mem.db");
process.env.MEMORY_PATH = path.join(tmp, "memories");
const workspaceA = path.join(tmp, "ws-default");
fs.mkdirSync(workspaceA, { recursive: true });

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const MARK_A = "ZEBRACORNWORKFLOWALPHA";   // stored workflow-private to wfA
const MARK_B = "NARWHALAGENTSHAREDBETA";   // stored agent-wide
const MARK_FOREIGN = "GRIFFINWORKFLOWFOREIGN"; // workflow-private to wfX

const hits = (contents: string[], marker: string) => contents.some((c) => c.includes(marker));

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const { applyMemoryOperations } = await import("../src/lib/memory/atomic-operations");
  const { SimpleMemoryProvider } = await import("../src/lib/memory/simple");
  const {
    atomicVisibilityAllowsId,
    filterAtomicResultsByVisibility,
    resolveAtomicVisibility,
  } = await import("../src/lib/memory/visibility-filter");
  const { buildSearchVisibility, buildWriteVisibility } = await import("../src/lib/memory/workflow-scope");
  const { collectStartupContext } = await import("../src/lib/workspace/files");
  const { normalizeWorkflowDefinition } = await import("../src/lib/engine/workflow-normalize");
  type Vis = { kind: "agent" | "workflow"; workflowId: string | null };

  initializeDatabase();

  console.log("\nNew-node defaults and legacy compatibility");
  const baseAgentNode = { id: "agent", type: "claude-agent", position: { x: 0, y: 0 }, data: { label: "Agent" } };
  const safeDefinition = normalizeWorkflowDefinition({ nodes: [baseAgentNode], edges: [], applySafeDefaults: true });
  check("new AI Agent defaults to workflow memory", safeDefinition.nodes[0]?.data.memoryAccess === "workflow");
  check("new AI Agent defaults dangerous tools to human approval", safeDefinition.nodes[0]?.data.approvalMode === "human");
  const legacyDefinition = normalizeWorkflowDefinition({ nodes: [baseAgentNode], edges: [] });
  check("legacy AI Agent is not silently migrated", legacyDefinition.nodes[0]?.data.memoryAccess == null && legacyDefinition.nodes[0]?.data.approvalMode == null);

  // Workflow A stores marker A in workflow scope.
  await applyMemoryOperations([{ op: "add", content: `Project secret ${MARK_A} for workflow A`, type: "fact" }],
    { agentId: "default", visibility: { kind: "workflow", id: "wfA" } });
  // Workflow X stores a foreign marker (private to wfX) that strongly matches.
  await applyMemoryOperations([{ op: "add", content: `${MARK_FOREIGN} ${MARK_A} ${MARK_A} ${MARK_A}`, type: "fact" }],
    { agentId: "default", visibility: { kind: "workflow", id: "wfX" } });
  // Marker B stored agent-wide.
  await applyMemoryOperations([{ op: "add", content: `Shared fact ${MARK_B} for the agent`, type: "fact" }],
    { agentId: "default", visibility: { kind: "agent", id: null } });

  // Exercise the real authorization layer over fast BM25 candidates (no model /
  // embedding runtime). This is the exact pre-ranking filter the search uses.
  const provider = new SimpleMemoryProvider("default");
  const otherProvider = new SimpleMemoryProvider("other-agent");
  async function scopedSearch(agentId: string, prov: InstanceType<typeof SimpleMemoryProvider>, query: string, visibility: Vis): Promise<string[]> {
    const resolved = resolveAtomicVisibility(agentId, visibility);
    const candidates = (await prov.search(query, 25, (id) => atomicVisibilityAllowsId(resolved, id)))
      .map((e) => ({ id: e.id, content: e.content }));
    return filterAtomicResultsByVisibility(agentId, candidates, visibility).map((c) => c.content);
  }

  console.log("\nWorkflow isolation");
  const wfBView = await scopedSearch("default", provider, MARK_A, { kind: "workflow", workflowId: "wfB" });
  check("workflow B cannot recall workflow A's private marker", !hits(wfBView, MARK_A), wfBView.join(" | "));

  const wfAView = await scopedSearch("default", provider, MARK_A, { kind: "workflow", workflowId: "wfA" });
  check("workflow A recalls its own marker (later execution)", hits(wfAView, MARK_A));
  check("workflow A does NOT see foreign workflow's marker", !hits(wfAView, MARK_FOREIGN), wfAView.join(" | "));
  check("workflow A scope excludes agent-wide marker B", !hits(wfAView, MARK_B));

  console.log("\nScope filtering happens before ranking");
  // Foreign entry repeats MARK_A many times (higher BM25), but is wfX-private.
  // Under wfA scope it must be excluded entirely, not merely ranked lower.
  const allCandidates = (await provider.search(MARK_A, 25)).map((e) => e.content);
  check("foreign entry would otherwise rank in unscoped results", hits(allCandidates, MARK_FOREIGN));
  check("higher-scoring foreign entry is excluded under wfA scope", !hits(wfAView, MARK_FOREIGN));

  console.log("\nScope filtering happens before provider ranking");
  const crowdQuery = "WORKFLOWVISIBILITYCROWD";
  for (let index = 0; index < 30; index++) {
    await applyMemoryOperations([{ op: "add", content: `${crowdQuery} ${crowdQuery} foreign ${index}`, type: "fact" }],
      { agentId: "default", visibility: { kind: "workflow", id: "wfX" } });
  }
  await applyMemoryOperations([{ op: "add", content: `${crowdQuery} own workflow result`, type: "fact" }],
    { agentId: "default", visibility: { kind: "workflow", id: "wfA" } });
  const wfAResolved = resolveAtomicVisibility("default", { kind: "workflow", workflowId: "wfA" });
  const prefilteredTopOne = await provider.search(crowdQuery, 1, (id) => atomicVisibilityAllowsId(wfAResolved, id));
  check("foreign high-score crowd cannot suppress an allowed result", prefilteredTopOne.length === 1 && prefilteredTopOne[0]!.content.includes("own workflow result"));

  console.log("\nAgent scope sharing is explicit");
  const agentView = await scopedSearch("default", provider, MARK_B, { kind: "agent", workflowId: null });
  check("agent scope recalls agent-wide marker B", hits(agentView, MARK_B));
  const agentViewA = await scopedSearch("default", provider, MARK_A, { kind: "agent", workflowId: null });
  check("agent scope does NOT expose any workflow-private marker", !hits(agentViewA, MARK_A) && !hits(agentViewA, MARK_FOREIGN), agentViewA.join(" | "));

  console.log("\nCross-agent isolation");
  const otherView = await scopedSearch("other-agent", otherProvider, MARK_A, { kind: "agent", workflowId: null });
  const otherViewB = await scopedSearch("other-agent", otherProvider, MARK_B, { kind: "agent", workflowId: null });
  check("a different agent recalls neither marker", !hits(otherView, MARK_A) && !hits(otherViewB, MARK_B));

  console.log("\nNo durable memory");
  const noneVisibility = buildSearchVisibility("none", "wfA");
  const noneView = filterAtomicResultsByVisibility("default", (await provider.search(MARK_B, 25)).map((entry) => ({ id: entry.id, content: entry.content })), noneVisibility);
  check("no-durable search visibility returns no atomic memories", noneView.length === 0);
  check("no-durable writes have no writable visibility", buildWriteVisibility("none", { workflowId: "wfA" }) === null);

  console.log("\nMutation isolation across agents");
  let crossAgentRejected = false;
  try {
    // Find marker A's id and try to mutate it as another agent.
    const { getSqlite } = await import("../src/lib/db");
    const row = getSqlite().prepare("SELECT id FROM memory_atomic_scope WHERE agent_id = 'default' LIMIT 1").get() as { id: string } | undefined;
    if (row) {
      await applyMemoryOperations([{ op: "remove", id: row.id }], { agentId: "other-agent" });
    }
  } catch {
    crossAgentRejected = true;
  }
  check("a different agent cannot mutate another agent's memory", crossAgentRejected);

  console.log("\nStartup memory modes");
  const fullBundle = collectStartupContext({ workspacePath: workspaceA });
  const hasMemoryMd = fullBundle.files.some((f) => f.path === "MEMORY.md");
  check("default (agent) startup includes MEMORY.md", hasMemoryMd);
  const scopedBundle = collectStartupContext({ workspacePath: workspaceA, excludeFiles: ["MEMORY.md"] });
  const scopedHasMemory = scopedBundle.files.some((f) => f.path === "MEMORY.md");
  check("no-durable / workflow startup excludes MEMORY.md", !scopedHasMemory);

  console.log(`\nworkflow-memory-scope-regression: ${passed}/${passed + failed} passed`);
  if (failed > 0) { console.error("Failed:", failures.join(", ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
