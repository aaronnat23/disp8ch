/**
 * Memory candidate regression (temp DB + temp memory dir, no model).
 *
 * Proves the cross-surface candidate lifecycle and the safety invariants from
 * docs/improvements/memory-evidence-candidates-and-cross-surface-plan-20260624:
 * candidates are not memory until applied, promotion uses the same scoped write
 * path as direct workflow memory, conflicts are flagged (never auto-resolved),
 * exact duplicates reinforce, freshness review surfaces, and secrets are
 * rejected before persistence.
 *
 * Run: pnpm exec tsx scripts/memory-candidates-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

type MemoryProposal = import("../src/lib/learning/self-learning-reviewer").MemoryProposal;

const tmp = path.join(os.tmpdir(), `disp8ch_mem_cand_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "cand.db");
process.env.MEMORY_PATH = path.join(tmp, "memories");
process.env.WORKSPACE_PATH = path.join(tmp, "workspace");

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Vis = { kind: "agent" | "workflow"; workflowId: string | null };

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const {
    createMemoryCandidate, getMemoryCandidate, applyMemoryCandidate, approveMemoryCandidate,
    rejectMemoryCandidate, classifyCandidate, listMemoryCandidates, listReviewDueCandidates, defaultFreshness,
  } = await import("../src/lib/memory/candidates");
  const { MemoryBatchValidationError } = await import("../src/lib/memory/atomic-operations");
  const { SimpleMemoryProvider } = await import("../src/lib/memory/simple");
  const { filterAtomicResultsByVisibility } = await import("../src/lib/memory/visibility-filter");
  const { createAgent } = await import("../src/lib/agents/registry");
  const { persistSelfLearningProposals } = await import("../src/lib/learning/self-learning-reviewer");

  initializeDatabase();
  const prov = new SimpleMemoryProvider("default");
  const otherProv = new SimpleMemoryProvider("other-agent");
  async function scopedHits(p: InstanceType<typeof SimpleMemoryProvider>, agentId: string, query: string, vis: Vis): Promise<string[]> {
    const cands = (await p.search(query, 25)).map((e) => ({ id: e.id, content: e.content }));
    return filterAtomicResultsByVisibility(agentId, cands, vis).map((c) => c.content);
  }
  const has = (arr: string[], m: string) => arr.some((c) => c.includes(m));

  console.log("\n[0] WebChat learning preserves the originating agent scope");
  const scopedAgent = createAgent({ id: "candidate-scope-agent", name: "Candidate scope agent" });
  const scopedMarker = "CANDSELFLEARNINGAGENTSCOPE";
  const scopedProposal: MemoryProposal = {
    kind: "memory",
    title: "Scoped preference",
    summary: `User ${scopedMarker} prefers concise release notes`,
    rationale: "Repeated correction",
    confidence: 0.9,
    evidence: ["turn 4"],
  };
  const scopedPersist = await persistSelfLearningProposals([scopedProposal], "sess-agent-scope", {
    agentId: scopedAgent.id,
  });
  const scopedCandidate = listMemoryCandidates({ agentId: scopedAgent.id })
    .find((candidate) => candidate.content.includes(scopedMarker));
  const defaultScopedCandidate = listMemoryCandidates({ agentId: "default" })
    .find((candidate) => candidate.content.includes(scopedMarker));
  check("self-learning proposal persisted", scopedPersist.written === 1);
  check("self-learning candidate belongs to the originating agent", scopedCandidate?.agentId === scopedAgent.id);
  check("self-learning candidate does not fall back to default agent", !defaultScopedCandidate);

  console.log("\n[1] WebChat candidate stays pending until approved, then retrievable");
  const M1 = "CANDWEBCHATPREFALPHA";
  const c1 = createMemoryCandidate({ agentId: "default", content: `User ${M1} prefers concise replies`, type: "preference", scopeKind: "agent", originType: "webchat", sessionId: "sess-1", evidence: ["turn 3"] });
  check("candidate created pending", c1.candidate.status === "pending" && c1.created);
  let before = await scopedHits(prov, "default", M1, { kind: "agent", workflowId: null });
  check("not retrievable while pending (not memory yet)", !has(before, M1));
  approveMemoryCandidate(c1.candidate.id);
  await applyMemoryCandidate(c1.candidate.id);
  const after = await scopedHits(prov, "default", M1, { kind: "agent", workflowId: null });
  check("retrievable in a later agent-scope search after apply", has(after, M1));
  check("candidate now applied", getMemoryCandidate(c1.candidate.id)?.status === "applied");

  console.log("\n[2] Workflow-private candidate promotes only into that workflow scope");
  const M2 = "CANDWORKFLOWFINDINGBETA";
  const c2 = createMemoryCandidate({ agentId: "default", content: `Finding ${M2} for workflow A`, type: "fact", scopeKind: "workflow", scopeId: "cand-wfA", originType: "workflow", originId: "cand-wfA", executionId: "exec-1", nodeId: "n1" });
  await applyMemoryCandidate(c2.candidate.id);
  const wfA = await scopedHits(prov, "default", M2, { kind: "workflow", workflowId: "cand-wfA" });
  const wfB = await scopedHits(prov, "default", M2, { kind: "workflow", workflowId: "cand-wfB" });
  const agentView = await scopedHits(prov, "default", M2, { kind: "agent", workflowId: null });
  check("retrievable in its own workflow scope", has(wfA, M2));
  check("NOT retrievable by another workflow", !has(wfB, M2));
  check("NOT retrievable by agent-wide search", !has(agentView, M2));

  console.log("\n[3] Explicit agent scope shared; other agent isolated");
  const M3 = "CANDAGENTSHAREDGAMMA";
  const c3 = createMemoryCandidate({ agentId: "default", content: `Shared ${M3} across workflows`, type: "fact", scopeKind: "agent", originType: "webchat" });
  await applyMemoryCandidate(c3.candidate.id);
  const agentHas = await scopedHits(prov, "default", M3, { kind: "agent", workflowId: null });
  const otherHas = await scopedHits(otherProv, "other-agent", M3, { kind: "agent", workflowId: null });
  check("agent-scope memory available to that agent", has(agentHas, M3));
  check("a different agent cannot recall it", !has(otherHas, M3));

  console.log("\n[4] Board candidate has origin link and is not memory until applied");
  const M4 = "CANDBOARDTASKDELTA";
  const c4 = createMemoryCandidate({ agentId: "default", content: `Resolution ${M4} from board task`, type: "decision", scopeKind: "agent", originType: "board", originId: "task-123", sourceSummary: "Resolved task" });
  check("origin link recorded", c4.candidate.originType === "board" && c4.candidate.originId === "task-123");
  const pre = await scopedHits(prov, "default", M4, { kind: "agent", workflowId: null });
  check("no memory entry exists before apply", !has(pre, M4));
  await applyMemoryCandidate(c4.candidate.id);
  const post = await scopedHits(prov, "default", M4, { kind: "agent", workflowId: null });
  check("memory entry exists after apply", has(post, M4));

  console.log("\n[5] Exact duplicate reinforces instead of creating a second entry");
  const dupContent = `User ${M1} prefers concise replies`; // identical to c1
  const c5 = createMemoryCandidate({ agentId: "default", content: dupContent, type: "preference", scopeKind: "agent", originType: "council", originId: "verdict-9" });
  classifyCandidate(getMemoryCandidate(c5.candidate.id)!);
  const c5after = getMemoryCandidate(c5.candidate.id)!;
  check("exact duplicate flagged as possible_duplicate", c5after.conflictState === "possible_duplicate", c5after.conflictState);
  check("duplicate has a related existing memory id", c5after.relatedIds.length > 0);
  const beforeCount = (await prov.getAll()).length;
  await applyMemoryCandidate(c5.candidate.id, { resolution: "reinforce_existing", targetMemoryId: c5after.relatedIds[0] });
  const afterCount = (await prov.getAll()).length;
  check("reinforce did not create a second entry", afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);

  console.log("\n[6] Potential conflict never silently replaces existing memory");
  // Existing agent memory: prefers dark mode. New candidate: prefers light mode.
  const c6base = createMemoryCandidate({ agentId: "default", content: "User prefers dark mode for the editor", type: "preference", scopeKind: "agent", originType: "webchat", originId: "conf-base" });
  await applyMemoryCandidate(c6base.candidate.id);
  const baseCount = (await prov.getAll()).length;
  const c6 = createMemoryCandidate({ agentId: "default", content: "User prefers light mode for the editor", type: "preference", scopeKind: "agent", originType: "webchat", originId: "conf-new" });
  classifyCandidate(getMemoryCandidate(c6.candidate.id)!);
  const c6after = getMemoryCandidate(c6.candidate.id)!;
  check("conflicting preference flagged as possible_conflict", c6after.conflictState === "possible_conflict", c6after.conflictState);
  const stillThere = await scopedHits(prov, "default", "dark mode", { kind: "agent", workflowId: null });
  check("existing memory untouched while candidate pending", has(stillThere, "dark mode"));
  check("conflicting candidate still pending (no silent apply)", c6after.status === "pending");
  check("no entry added merely by classifying", (await prov.getAll()).length === baseCount);

  console.log("\n[7] Review-due facts surface for maintenance");
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const c7 = createMemoryCandidate({ agentId: "default", content: "Server CANDFRESHEPSILON runs version 1.2", type: "fact", scopeKind: "agent", originType: "notebook", reviewAfter: past });
  const due = listReviewDueCandidates();
  check("review-due candidate appears in maintenance", due.some((d) => d.id === c7.candidate.id));
  check("preference type has no auto-expiry default", defaultFreshness("preference").reviewAfter === null);
  check("fact type gets a review window default", defaultFreshness("fact").reviewAfter !== null);

  console.log("\n[8] Secret-shaped value rejected before persistence");
  let rejected = false;
  try {
    const secretLikeValue = `sk-${"ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"}`;
    createMemoryCandidate({ agentId: "default", content: `api key is ${secretLikeValue}`, type: "fact", scopeKind: "agent", originType: "webchat" });
  } catch (e) { rejected = e instanceof MemoryBatchValidationError; }
  check("secret-shaped candidate rejected", rejected);

  console.log("\n[9] Idempotency + reject");
  const c9a = createMemoryCandidate({ agentId: "default", content: "Idempotent fact CANDIDEMP", type: "fact", scopeKind: "agent", originType: "board", originId: "idem-1" });
  const c9b = createMemoryCandidate({ agentId: "default", content: "Idempotent fact CANDIDEMP", type: "fact", scopeKind: "agent", originType: "board", originId: "idem-1" });
  check("duplicate origin+content is idempotent (same id, not re-created)", c9a.candidate.id === c9b.candidate.id && !c9b.created);
  rejectMemoryCandidate(c9a.candidate.id);
  check("rejected candidate cannot be applied", await applyMemoryCandidate(c9a.candidate.id).then(() => false).catch(() => true));

  console.log(`\nmemory-candidates-regression: ${passed}/${passed + failed} passed`);
  if (failed > 0) { console.error("Failed:", failures.join(", ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
