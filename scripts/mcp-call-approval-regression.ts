#!/usr/bin/env tsx
/**
 * MCP call-approval lifecycle regression.
 * Verifies durable pending approvals, one-time idempotent execution, scope
 * recheck after approval, denial, redaction, and session delivery — using an
 * injected executor so no real MCP server is required.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MCPApprovalMode } from "@/lib/mcp/client";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-mcp-appr-"));
  process.env.DATABASE_PATH = path.join(tempRoot, "mcp.db");

  const { initializeDatabase, getSqlite } = await import("@/lib/db");
  const mod = await import("@/lib/mcp/call-approval");
  initializeDatabase();
  mod.ensureMcpCallApprovalTable();

  // --- pure redaction + hashing ---
  const redacted = mod.redactMcpArgs({ apiKey: "sk-secret", path: "/x", token: "abc", nested: { password: "p", keep: "y" } });
  check("redact.secretKey", redacted.apiKey === "[redacted]" && redacted.token === "[redacted]");
  check("redact.nestedSecret", (redacted.nested as Record<string, unknown>).password === "[redacted]");
  check("redact.keepsSafe", redacted.path === "/x" && (redacted.nested as Record<string, unknown>).keep === "y");
  check("hash.stableRegardlessOfOrder", mod.hashMcpArgs({ a: 1, b: 2 }) === mod.hashMcpArgs({ b: 2, a: 1 }));
  check("hash.differsOnChange", mod.hashMcpArgs({ a: 1 }) !== mod.hashMcpArgs({ a: 2 }));

  const base = {
    agentId: "agent-1",
    sessionId: "sess-1",
    serverName: "files",
    toolName: "write_note",
    approvalMode: "human" as MCPApprovalMode,
  };

  // --- create pending ---
  const created = mod.createMcpCallApproval({ ...base, toolArgs: { apiKey: "sk-zzz", text: "hello" } });
  check("create.pending", created.status === "pending");
  check("create.redactsStored", created.argsRedacted.apiKey === "[redacted]" && created.argsRedacted.text === "hello");
  check("create.listed", mod.listPendingMcpCallApprovals().some((a) => a.id === created.id));

  // --- approve executes exactly once via injected executor + delivers to session ---
  let execCount = 0;
  let execArgs: Record<string, unknown> | null = null;
  const delivered: string[] = [];
  const deps = {
    evaluateAccess: () => ({ allowed: true, approvalMode: "human" as MCPApprovalMode }),
    execute: async (_s: string, _t: string, full: Record<string, unknown>) => {
      execCount += 1;
      execArgs = full;
      return "note written";
    },
    deliver: (_rec: unknown, content: string) => { delivered.push(content); },
  };

  const r1 = await mod.resolveMcpCallApproval(created.id, "approve", undefined, deps);
  check("approve.executed", r1.ok && r1.status === "executed" && r1.result === "note written");
  check("approve.execOnce", execCount === 1);
  check("approve.fullArgsUsed", !!execArgs && (execArgs as Record<string, unknown>).apiKey === "sk-zzz");
  check("approve.delivered", delivered.length === 1 && delivered[0].includes("note written"));
  check("approve.statusPersisted", mod.getMcpCallApproval(created.id)?.status === "executed");

  // --- idempotency: second approve does not re-execute ---
  const r2 = await mod.resolveMcpCallApproval(created.id, "approve", undefined, deps);
  check("idempotent.secondApproveNoop", !r2.ok && r2.status === "already_resolved");
  check("idempotent.execStillOnce", execCount === 1);

  // --- default delivery writes a real session message (no deliver injected) ---
  const deliverable = mod.createMcpCallApproval({ ...base, sessionId: "sess-default", toolArgs: { text: "deliver me" } });
  await mod.resolveMcpCallApproval(deliverable.id, "approve", undefined, {
    evaluateAccess: () => ({ allowed: true, approvalMode: "human" as MCPApprovalMode }),
    execute: async () => "delivered result",
    // deliver omitted -> uses default persistChannelMessage path
  });
  const msgs = getSqlite().prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get("sess-default") as { c: number };
  check("delivery.sessionMessageWritten", msgs.c >= 1);

  // --- deny does not execute ---
  let denyExec = 0;
  const denied = mod.createMcpCallApproval({ ...base, toolArgs: { text: "y" } });
  const rd = await mod.resolveMcpCallApproval(denied.id, "deny", "not now", {
    evaluateAccess: () => ({ allowed: true, approvalMode: "human" as MCPApprovalMode }),
    execute: async () => { denyExec += 1; return "x"; },
    deliver: () => {},
  });
  check("deny.status", rd.ok && rd.status === "denied");
  check("deny.noExec", denyExec === 0);
  check("deny.persisted", mod.getMcpCallApproval(denied.id)?.status === "denied");

  // --- scope revoked after approval: re-check blocks execution ---
  let revokedExec = 0;
  const revoked = mod.createMcpCallApproval({ ...base, toolArgs: { text: "z" } });
  const rr = await mod.resolveMcpCallApproval(revoked.id, "approve", undefined, {
    evaluateAccess: () => ({ allowed: false, reason: "agent-not-allowed", approvalMode: "off" as MCPApprovalMode }),
    execute: async () => { revokedExec += 1; return "should not run"; },
    deliver: () => {},
  });
  check("scope.blocked", !rr.ok && rr.status === "scope_revoked");
  check("scope.noExec", revokedExec === 0);
  check("scope.persisted", mod.getMcpCallApproval(revoked.id)?.status === "scope_revoked");

  // --- missing id ---
  const miss = await mod.resolveMcpCallApproval("nope", "approve", undefined, deps);
  check("missing.handled", !miss.ok && miss.status === "missing");

  try { getSqlite().close(); } catch { /* ignore */ }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nmcp-call-approval-regression: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.error("Failed:", failed.map((r) => r.name).join(", "));
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
