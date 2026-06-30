/**
 * Workflow effect classification regression (pure, no DB, no model).
 *
 * Proves the canonical effect model: configuration-sensitive resolvers, SQL
 * verb classification, the hardline floor, completeness for every registered
 * node handler type, and the deterministic policy decisions (balanced/strict/
 * custom + unattended downgrade).
 *
 * Run: pnpm exec tsx scripts/workflow-effect-classification-regression.ts
 */
import {
  resolveNodeEffect,
  classifySql,
  criticalNeverAllow,
  hasResolverOrBaseline,
  listKnownEffectTypes,
} from "../src/lib/engine/effects";
import { decideEffectPolicy, modelMayDowngrade } from "../src/lib/engine/effect-policy";
import { getAllNodeContracts } from "../src/lib/engine/node-contracts";
import { getRegisteredNodeTypes } from "../src/lib/engine/node-registry";
import type { ApprovalPolicy } from "../src/types/execution";
import { resolveAgentToolEffect } from "../src/lib/engine/tools";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function kind(type: string, config: Record<string, unknown>): string {
  return resolveNodeEffect(type, config).kind;
}

console.log("\nHTTP method sensitivity");
check("GET is read", kind("http-request", { method: "GET" }) === "read");
check("HEAD is read", kind("http-request", { method: "HEAD" }) === "read");
check("POST is external_write", kind("http-request", { method: "POST" }) === "external_write");
check("PATCH is external_write", kind("http-request", { method: "PATCH" }) === "external_write");
check("PUT is external_write", kind("http-request", { method: "PUT" }) === "external_write");
check("DELETE is destructive", kind("http-request", { method: "DELETE" }) === "destructive");

console.log("\nSQL verb classification");
check("SELECT is read", classifySql("SELECT * FROM t", null).kind === "read");
check("PRAGMA read is read", classifySql("PRAGMA table_info(t)", null).kind === "read");
check("INSERT is local_write", classifySql("INSERT INTO t VALUES (1)", null).kind === "local_write");
check("bounded UPDATE is high local_write", (() => { const e = classifySql("UPDATE t SET x=1 WHERE id=2", null); return e.kind === "local_write" && e.risk === "high"; })());
check("unbounded DELETE is destructive+critical", (() => { const e = classifySql("DELETE FROM t", null); return e.kind === "destructive" && e.risk === "critical"; })());
check("DROP is destructive+critical", (() => { const e = classifySql("DROP TABLE t", null); return e.kind === "destructive" && e.risk === "critical"; })());
check("TRUNCATE is destructive", classifySql("TRUNCATE t", null).kind === "destructive");
check("multi-statement fails closed to unknown", classifySql("SELECT 1; DROP TABLE t", null).kind === "unknown");
check("single trailing semicolon is fine", classifySql("SELECT 1;", null).kind === "read");

console.log("\nSystem / clipboard / git / document / scheduler / board resolvers");
check("system specs is read", kind("system-command", { action: "pc-specs" }) === "read");
check("system list-files is read", kind("system-command", { command: "list-files" }) === "read");
check("system move-files is local_write", kind("system-command", { action: "move-files" }) === "local_write");
check("system free-form command is external_write", kind("system-command", { command: "curl https://x" }) === "external_write");
check("clipboard read is read", kind("clipboard", { action: "read" }) === "read");
check("clipboard write is local_write", kind("clipboard", { action: "write" }) === "local_write");
check("git status is read", kind("git-operation", { action: "status" }) === "read");
check("git commit is local_write", kind("git-operation", { action: "commit" }) === "local_write");
check("git push is external_write", kind("git-operation", { action: "push" }) === "external_write");
check("git force-push is destructive", kind("git-operation", { action: "force-push" }) === "destructive");
check("git reset is destructive", kind("git-operation", { action: "reset" }) === "destructive");
check("document search is read", kind("document-tool", { action: "search" }) === "read");
check("document delete is destructive", kind("document-tool", { action: "delete" }) === "destructive");
check("document scrape is local_write", kind("document-tool", { action: "scrape" }) === "local_write");
check("scheduler list is read", kind("scheduler-job", { action: "list" }) === "read");
check("scheduler create is local_write", kind("scheduler-job", { action: "create" }) === "local_write");
check("scheduler run is external_write", kind("scheduler-job", { action: "run" }) === "external_write");
check("board list is read", kind("board-task", { action: "list" }) === "read");
check("board create is local_write", kind("board-task", { action: "create" }) === "local_write");

console.log("\nSend nodes + memory + placeholder");
check("send-webchat is local_write", kind("send-webchat", {}) === "local_write");
check("send-telegram is external_send", kind("send-telegram", {}) === "external_send");
check("send-email is external_send", kind("send-email", {}) === "external_send");
check("memory-store is local_write", kind("memory-store", {}) === "local_write");
check("memory-recall is read", kind("memory-recall", {}) === "read");
check("placeholder is unknown", kind("placeholder", {}) === "unknown");
check("write-file is local_write", kind("write-file", {}) === "local_write");

console.log("\nNested agent tool effects");
check("tool HTTP GET is read", resolveAgentToolEffect("http_request", { method: "GET", url: "https://example.com" }).kind === "read");
check("tool HTTP POST is external_write", resolveAgentToolEffect("http_request", { method: "POST", url: "https://example.com" }).kind === "external_write");
check("tool HTTP DELETE is destructive", resolveAgentToolEffect("http_request", { method: "DELETE", url: "https://example.com" }).kind === "destructive");
check("tool browser click is external_write", resolveAgentToolEffect("browser_click", { selector: "button[type=submit]" }).kind === "external_write");
check("tool memory store is local_write", resolveAgentToolEffect("memory_store", { content: "fact" }).kind === "local_write");

console.log("\nHardline floor (cannot be approved)");
check("mkfs blocked", criticalNeverAllow("system-command", { command: "mkfs.ext4 /dev/sda" }).blocked);
check("rm -rf / blocked", criticalNeverAllow("system-command", { command: "rm -rf /" }).blocked);
check("shutdown blocked", criticalNeverAllow("system-command", { command: "shutdown -h now" }).blocked);
check("dd to raw device blocked", criticalNeverAllow("system-command", { command: "dd if=/dev/zero of=/dev/sda" }).blocked);
check("fork bomb blocked", criticalNeverAllow("system-command", { command: ":(){ :|:& };:" }).blocked);
check("ordinary command not blocked", !criticalNeverAllow("system-command", { command: "echo hello" }).blocked);
check("bounded rm not blocked", !criticalNeverAllow("system-command", { command: "rm -rf ./build" }).blocked);

console.log("\nCompleteness: every registered handler type resolves a known effect");
const registered = getRegisteredNodeTypes();
const missing = registered.filter((t) => !hasResolverOrBaseline(t));
check(`all ${registered.length} handler types classified (missing: ${missing.join(", ") || "none"})`, missing.length === 0, missing.join(", "));
const contractTypes = getAllNodeContracts().map((c) => c.type).filter((t) => t !== "unknown");
const contractMissing = contractTypes.filter((t) => !hasResolverOrBaseline(t));
check(`all contract types classified (missing: ${contractMissing.join(", ") || "none"})`, contractMissing.length === 0, contractMissing.join(", "));
check("known effect types non-empty", listKnownEffectTypes().length > 30);

console.log("\nPolicy decisions");
const balanced: ApprovalPolicy = { mode: "balanced" };
const strict: ApprovalPolicy = { mode: "strict" };
const dec = (policy: ApprovalPolicy, type: string, config: Record<string, unknown>, attended = true, nodeId = "n1") =>
  decideEffectPolicy({ effect: resolveNodeEffect(type, config), policy, nodeId, attended });
check("balanced: read allows", dec(balanced, "memory-recall", {}).decision === "allow");
check("balanced: local write allows", dec(balanced, "memory-store", {}).decision === "allow");
check("balanced: webchat reply allows", dec(balanced, "send-webchat", {}).decision === "allow");
check("balanced: external send approves", dec(balanced, "send-telegram", {}).decision === "approve");
check("balanced: HTTP POST approves", dec(balanced, "http-request", { method: "POST" }).decision === "approve");
check("balanced: unbounded DELETE approves (attended)", dec(balanced, "database-query", { query: "DELETE FROM t" }).decision === "approve");
check("balanced: placeholder denies", dec(balanced, "placeholder", {}).decision === "deny");
check("strict: local write approves", dec(strict, "memory-store", {}).decision === "approve");
check("strict: read allows", dec(strict, "read-file", {}).decision === "allow");
check("custom auto allows send", decideEffectPolicy({ effect: resolveNodeEffect("send-telegram", {}), policy: { mode: "custom", nodes: { n1: "auto" } }, nodeId: "n1", attended: true }).decision === "allow");
check("custom deny blocks send", decideEffectPolicy({ effect: resolveNodeEffect("send-telegram", {}), policy: { mode: "custom", nodes: { n1: "deny" } }, nodeId: "n1", attended: true }).decision === "deny");
check("custom auto still denies unknown", decideEffectPolicy({ effect: resolveNodeEffect("placeholder", {}), policy: { mode: "custom", nodes: { n1: "auto" } }, nodeId: "n1", attended: true }).decision === "deny");

console.log("\nUnattended downgrade");
check("unattended balanced send denies", dec(balanced, "send-telegram", {}, false).decision === "deny");
check("unattended destructive denies", dec(balanced, "http-request", { method: "DELETE" }, false).decision === "deny");
check("unattended pre-authorized allows", decideEffectPolicy({ effect: resolveNodeEffect("send-telegram", {}), policy: balanced, nodeId: "n1", attended: false, preAuthorized: true }).decision === "allow");

console.log("\nModel guardian floor");
check("model may downgrade low local write", modelMayDowngrade(resolveNodeEffect("memory-store", {})));
check("model may NOT downgrade external send", !modelMayDowngrade(resolveNodeEffect("send-telegram", {})));
check("model may NOT downgrade destructive", !modelMayDowngrade(resolveNodeEffect("http-request", { method: "DELETE" })));
check("model may NOT downgrade unknown", !modelMayDowngrade(resolveNodeEffect("placeholder", {})));

console.log(`\nworkflow-effect-classification-regression: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error("Failed:", failures.join(", "));
  process.exit(1);
}
