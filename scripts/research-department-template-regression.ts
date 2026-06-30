/**
 * Research Department template/setup regression (temp DB, no model, inactive
 * workflows so nothing schedules).
 *
 * Guards the tiered setup service: which agents/workflows/folders each tier
 * creates, per-role isolation (tools/prompt/temperature differ), MCP scoping to
 * the Analyst only, and that every generated workflow graph is structurally
 * valid and connected — all built from generic node types.
 *
 * Run: pnpm exec tsx scripts/research-department-template-regression.ts
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(os.tmpdir(), `disp8ch_rd_template_${Date.now()}.db`);

let passed = 0;
let failed = 0;
const failures: string[] = [];
const cleanupVaults: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const { createResearchDepartment } = await import("../src/lib/research-department/setup");
  const { getDepartmentDetail } = await import("../src/lib/research-department/store");
  const { getAgentById } = await import("../src/lib/agents/registry");
  const { validateGraph } = await import("../src/lib/research-department/workflows");
  const { getSqlite } = await import("../src/lib/db");
  const { computeVaultPaths, removeVault } = await import("../src/lib/research-department/vault");

  function workflowGraph(workflowId: string): { nodes: unknown[]; edges: unknown[] } {
    const row = getSqlite().prepare("SELECT nodes, edges FROM workflows WHERE id = ?").get(workflowId) as
      | { nodes: string; edges: string }
      | undefined;
    return { nodes: JSON.parse(row?.nodes || "[]"), edges: JSON.parse(row?.edges || "[]") };
  }

  // ── Basic tier ─────────────────────────────────────────────────────────────
  console.log("\nBasic tier");
  {
    const r = createResearchDepartment({
      name: "Basic Desk",
      tier: "basic",
      focusArea: "local-first AI agents",
      sources: { keywords: ["local agents"], rssFeeds: ["https://example.com/feed"], arxivCategories: [], competitorUrls: [] },
      inactive: true,
    });
    cleanupVaults.push(r.vaultRoot);
    const roles = r.agents.map((a) => a.role).sort();
    check("basic creates scout + briefer only", roles.join(",") === "briefer,scout", roles.join(","));
    check("basic has no analyst", !r.agents.some((a) => a.role === "analyst"));
    const kinds = r.workflows.map((w) => w.kind).sort();
    check("basic has a scout workflow", kinds.some((k) => k.startsWith("scout_")));
    check("basic has briefer_morning", kinds.includes("briefer_morning"));
    check("basic has no analyst_inbox", !kinds.includes("analyst_inbox"));
    const paths = computeVaultPaths(r.vaultRoot);
    check("basic vault inbox exists", fs.existsSync(paths.inbox));
    check("basic vault SCHEMA exists", fs.existsSync(paths.schema));
  }

  // ── Standard tier ──────────────────────────────────────────────────────────
  console.log("\nStandard tier");
  let standardDeptId = "";
  {
    const r = createResearchDepartment({
      name: "Standard Desk",
      tier: "standard",
      focusArea: "workflow automation",
      sources: { keywords: ["automation"], rssFeeds: ["https://example.com/feed"], arxivCategories: ["cs.AI"], competitorUrls: [] },
      inactive: true,
    });
    cleanupVaults.push(r.vaultRoot);
    standardDeptId = r.departmentId;
    const roles = r.agents.map((a) => a.role).sort();
    check("standard creates scout + analyst + briefer", roles.join(",") === "analyst,briefer,scout", roles.join(","));
    const kinds = r.workflows.map((w) => w.kind);
    check("standard has analyst_inbox", kinds.includes("analyst_inbox"));
    check("standard has scout_arxiv (arxiv configured)", kinds.includes("scout_arxiv"));
    check("standard has no weekly synthesis", !kinds.includes("analyst_weekly_synthesis"));

    // Per-role isolation
    const scout = getAgentById(r.agents.find((a) => a.role === "scout")!.agentId)!;
    const analyst = getAgentById(r.agents.find((a) => a.role === "analyst")!.agentId)!;
    const briefer = getAgentById(r.agents.find((a) => a.role === "briefer")!.agentId)!;
    check("scout and analyst have distinct prompts", scout.systemPrompt !== analyst.systemPrompt);
    check("scout and analyst have distinct temperatures", scout.temperature !== analyst.temperature);
    check("briefer has its own prompt", briefer.systemPrompt !== scout.systemPrompt && briefer.systemPrompt !== analyst.systemPrompt);
    check("standard analyst has no MCP extension", analyst.enabledExtensions.length === 0);

    // Graph validity for every workflow
    const detail = getDepartmentDetail(standardDeptId)!;
    for (const link of detail.workflows) {
      const g = workflowGraph(link.workflowId);
      const v = validateGraph(g.nodes as never[], g.edges as never[]);
      check(`graph valid + connected: ${link.kind}`, v.valid, v.errors.join("; "));
    }

    // Analyst inbox workflow must gate the model call behind an if-else
    const inboxLink = detail.workflows.find((w) => w.kind === "analyst_inbox")!;
    const g = workflowGraph(inboxLink.workflowId);
    const nodes = g.nodes as Array<{ type: string; data?: Record<string, unknown> }>;
    const edges = g.edges as Array<{ source: string; target: string; sourceHandle?: string }>;
    check("analyst_inbox has an if-else preflight gate", nodes.some((n) => n.type === "if-else"));
    check("analyst_inbox uses only generic node types", nodes.every((n) => n.type !== "research-department"));
    check("analyst_inbox has a claude-agent node", nodes.some((n) => n.type === "claude-agent"));
    // Content injection: a read-file node loads inbox content and feeds the agent,
    // and the agent prompt references the injected content (no per-file tool churn).
    const readNode = nodes.find((n) => n.type === "read-file");
    const agentNode = nodes.find((n) => n.type === "claude-agent");
    const preflightNode = nodes.find((n) => n.type === "run-code" && String(n.data?.label || "").includes("Preflight"));
    const writeSummaryNode = nodes.find((n) => n.type === "write-file" && String(n.data?.label || "").includes("Synthesis Summary"));
    const moveNode = nodes.find((n) => n.type === "system-command" && n.data?.action === "move-files");
    check("analyst_inbox pre-loads inbox content via read-file", Boolean(readNode));
    check("analyst read-file feeds the claude-agent", Boolean(readNode && agentNode && edges.some((e) => e.source === (readNode as { id?: string }).id && e.target === (agentNode as { id?: string }).id)));
    check("analyst prompt injects {{read.content}}", String(agentNode?.data?.systemPrompt || "").includes("{{read.content}}"));
    check("analyst uses a broad-research tool budget lane", agentNode?.data?.modelLedLane === "broad_research");
    check("analyst has enough tool budget for multi-note synthesis", Number(agentNode?.data?.maxToolCalls || 0) >= 64);
    check("analyst moves processed files with a generic system-command action", Boolean(moveNode));
    check("analyst move is bounded to the vault root", Boolean(moveNode?.data?.allowedRoot));
    check("analyst move waits for preflight file list and summary write", Boolean(
      moveNode &&
      preflightNode &&
      writeSummaryNode &&
      edges.some((e) => e.source === (preflightNode as { id?: string }).id && e.target === (moveNode as { id?: string }).id) &&
      edges.some((e) => e.source === (writeSummaryNode as { id?: string }).id && e.target === (moveNode as { id?: string }).id),
    ));

    const brieferLink = detail.workflows.find((w) => w.kind === "briefer_morning")!;
    const bg = workflowGraph(brieferLink.workflowId);
    const bNodes = bg.nodes as Array<{ type: string; data?: Record<string, unknown> }>;
    const bAgent = bNodes.find((n) => n.type === "claude-agent");
    check("briefer pre-loads notes via read-file", bNodes.some((n) => n.type === "read-file"));
    check("briefer prompt injects {{read.content}}", String(bAgent?.data?.systemPrompt || "").includes("{{read.content}}"));
    check("briefer runs tool-free (single-pass, no tool budget)", Array.isArray(bAgent?.data?.enabledTools) && (bAgent!.data!.enabledTools as unknown[]).length === 0);
  }

  // ── Advanced tier ──────────────────────────────────────────────────────────
  console.log("\nAdvanced tier");
  {
    const r = createResearchDepartment({
      name: "Advanced Desk",
      tier: "advanced",
      focusArea: "competitive intelligence",
      sources: {
        keywords: ["pricing"],
        rssFeeds: ["https://example.com/feed"],
        arxivCategories: [],
        competitorUrls: ["https://example.com/pricing"],
      },
      safety: { analystMcpServer: "notebook-synth" },
      inactive: true,
    });
    cleanupVaults.push(r.vaultRoot);
    const kinds = r.workflows.map((w) => w.kind);
    check("advanced has competitor diff", kinds.includes("scout_competitor_diff"));
    check("advanced has weekly synthesis", kinds.includes("analyst_weekly_synthesis"));

    const analyst = getAgentById(r.agents.find((a) => a.role === "analyst")!.agentId)!;
    const scout = getAgentById(r.agents.find((a) => a.role === "scout")!.agentId)!;
    check("MCP scoped to analyst", analyst.enabledExtensions.includes("notebook-synth"));
    check("MCP NOT given to scout", !scout.enabledExtensions.includes("notebook-synth"));
    check("advanced agents block on budget", analyst.budgetAction === "block");

    const detail = getDepartmentDetail(r.departmentId)!;
    for (const link of detail.workflows) {
      const g = workflowGraph(link.workflowId);
      const v = validateGraph(g.nodes as never[], g.edges as never[]);
      check(`graph valid + connected: ${link.kind}`, v.valid, v.errors.join("; "));
    }
  }

  // Cleanup
  for (const vault of cleanupVaults) removeVault(vault);
}

main()
  .then(() => {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`research-department-template-regression: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("Failed cases:", failures.join(", "));
      process.exit(1);
    }
    console.log("All template regression tests passed.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
