#!/usr/bin/env tsx
/**
 * MCP approval guardian (`model` mode) regression.
 * Covers verdict parsing, the read-only safety floor, escalate-on-uncertainty,
 * and the guardian-decided durable audit path (auto-approve executes once and
 * is attributed to 'guardian' without delivering a duplicate session message).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessMcpCall,
  parseGuardianVerdict,
  type GuardianLLM,
} from "@/lib/mcp/guardian";
import type { MCPApprovalMode } from "@/lib/mcp/client";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const approveLLM: GuardianLLM = async () => "APPROVE";
const denyLLM: GuardianLLM = async () => "DENY";
const proseLLM: GuardianLLM = async () => "I think maybe this is fine but unsure";
const throwLLM: GuardianLLM = async () => { throw new Error("model down"); };

async function main() {
  // --- verdict parsing ---
  check("parse.approve", parseGuardianVerdict("APPROVE") === "approve");
  check("parse.deny", parseGuardianVerdict("deny\n") === "deny");
  check("parse.proseEscalates", parseGuardianVerdict("not sure") === "escalate");
  check("parse.emptyEscalates", parseGuardianVerdict("") === "escalate");

  const ro = { serverName: "files", toolName: "read", argsRedacted: {}, readonly: true };

  // --- read-only floor: non-readonly never auto-approves ---
  let calledLLM = false;
  const spyLLM: GuardianLLM = async () => { calledLLM = true; return "APPROVE"; };
  const writeDecision = await assessMcpCall({ ...ro, readonly: false }, spyLLM);
  check("floor.writeEscalates", writeDecision.verdict === "escalate" && writeDecision.via === "readonly-floor");
  check("floor.llmNotConsultedForWrite", calledLLM === false);
  const unknownDecision = await assessMcpCall({ ...ro, readonly: null }, spyLLM);
  check("floor.unknownEscalates", unknownDecision.verdict === "escalate" && unknownDecision.via === "readonly-floor");

  // --- read-only tools consult the guardian ---
  check("ro.approve", (await assessMcpCall(ro, approveLLM)).verdict === "approve");
  check("ro.deny", (await assessMcpCall(ro, denyLLM)).verdict === "deny");
  check("ro.proseEscalates", (await assessMcpCall(ro, proseLLM)).verdict === "escalate");
  const fb = await assessMcpCall(ro, throwLLM);
  check("ro.errorEscalatesViaFallback", fb.verdict === "escalate" && fb.via === "fallback");

  // --- guardian-decided durable audit path ---
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-guardian-"));
  process.env.DATABASE_PATH = path.join(tempRoot, "g.db");
  const { initializeDatabase, getSqlite } = await import("@/lib/db");
  const ca = await import("@/lib/mcp/call-approval");
  initializeDatabase();
  ca.ensureMcpCallApprovalTable();

  const base = { agentId: "a1", sessionId: "s1", serverName: "files", toolName: "read", approvalMode: "model" as MCPApprovalMode };

  let execCount = 0;
  const rec = ca.createMcpCallApproval({ ...base, toolArgs: { q: "x" }, reasoning: "looks safe" });
  const approved = await ca.resolveMcpCallApproval(
    rec.id, "approve", "guardian: looks safe",
    { evaluateAccess: () => ({ allowed: true, approvalMode: "model" as MCPApprovalMode }), execute: async () => { execCount += 1; return "read-ok"; } },
    { decidedBy: "guardian", deliver: false },
  );
  check("audit.guardianExecuted", approved.ok && approved.status === "executed" && approved.result === "read-ok");
  check("audit.execOnce", execCount === 1);
  check("audit.decidedByGuardian", ca.getMcpCallApproval(rec.id)?.decidedBy === "guardian");
  check("audit.reasoningStored", ca.getMcpCallApproval(rec.id)?.reasoning === "looks safe");
  const noDelivery = getSqlite().prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get("s1") as { c: number };
  check("audit.noInlineDuplicateDelivery", noDelivery.c === 0);

  // guardian deny audit
  let denyExec = 0;
  const rec2 = ca.createMcpCallApproval({ ...base, toolArgs: {}, reasoning: "exfiltration risk" });
  const den = await ca.resolveMcpCallApproval(
    rec2.id, "deny", "guardian: exfiltration risk",
    { execute: async () => { denyExec += 1; return "x"; } },
    { decidedBy: "guardian", deliver: false },
  );
  check("auditDeny.status", den.ok && den.status === "denied");
  check("auditDeny.noExec", denyExec === 0);
  check("auditDeny.decidedByGuardian", ca.getMcpCallApproval(rec2.id)?.decidedBy === "guardian");

  try { getSqlite().close(); } catch { /* ignore */ }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nmcp-guardian-regression: ${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((error) => { console.error(error); process.exit(1); });
