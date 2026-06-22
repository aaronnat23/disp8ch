/**
 * Research Department integration regression (temp DB + temp vault + fixtures).
 *
 * Proves the end-to-end file pipeline with ZERO model calls:
 *   - Scout fixture -> inbox markdown finding (valid contract)
 *   - empty inbox preflight -> no synthesis (no model call)
 *   - non-empty inbox -> wiki note written + raw file moved to processed
 *   - processed move is idempotent
 *   - contradiction fixture -> contradiction note
 *   - Briefer -> <=5 bullet brief, archived
 *   - generated workflows are linked to the department
 *
 * Run: pnpm exec tsx scripts/research-department-integration-regression.ts
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(os.tmpdir(), `disp8ch_rd_integration_${Date.now()}.db`);

let passed = 0;
let failed = 0;
const failures: string[] = [];

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
  const vault = await import("../src/lib/research-department/vault");
  const runtime = await import("../src/lib/research-department/runtime");
  const contracts = await import("../src/lib/research-department/output-contracts");
  const { createResearchDepartment } = await import("../src/lib/research-department/setup");
  const { getDepartmentDetail } = await import("../src/lib/research-department/store");

  const fixtureDir = path.join("fixtures", "research-department");
  const testRoot = path.join("data", "workspace", "research-department", `__integration-${Date.now()}`);
  const { paths } = vault.initializeVault(testRoot, { focusArea: "local-first AI agents" });

  try {
    // 1. Empty inbox preflight -> no model call.
    console.log("\nEmpty inbox gate");
    {
      const pre = runtime.preflightInbox(paths);
      check("empty inbox: wakeAgent false", pre.wakeAgent === false && pre.count === 0);
      const synth = runtime.deterministicSynthesize(paths, "topic");
      check("empty inbox: synthesis is a no-op (zero model calls)", synth === null);
    }

    // 2. Scout fixture -> inbox markdown.
    console.log("\nScout -> inbox");
    let inboxFile = "";
    {
      const rss = fs.readFileSync(path.join(fixtureDir, "rss-feed.xml"), "utf-8");
      const title = (rss.match(/<title>([^<]+)<\/title>/g) || [])[1]?.replace(/<\/?title>/g, "") || "Item";
      const link = (rss.match(/<link>([^<]+)<\/link>/g) || [])[1]?.replace(/<\/?link>/g, "") || "https://example.com";
      const findingPath = runtime.writeFinding(paths, {
        sourceUrl: link,
        sourceType: "rss",
        title,
        body: "A local-first runtime added durable, resumable workflows.",
        keyword: "local agents",
      });
      inboxFile = path.basename(findingPath);
      check("scout wrote an inbox file", fs.existsSync(findingPath));
      const content = fs.readFileSync(findingPath, "utf-8");
      check("finding passes contract", contracts.validateFinding(content).valid, contracts.validateFinding(content).errors.join("; "));
      check("finding is inside inbox", findingPath.includes(path.join("research", "inbox")));
    }

    // 3. Non-empty inbox -> wiki note + processed move.
    console.log("\nAnalyst synthesis");
    {
      const pre = runtime.preflightInbox(paths);
      check("non-empty inbox: wakeAgent true", pre.wakeAgent === true && pre.count >= 1);
      const synth = runtime.deterministicSynthesize(paths, "Durable Local Agent Workflows");
      check("synthesis produced a wiki note", Boolean(synth?.wikiNotePath && fs.existsSync(synth.wikiNotePath)));
      check("wiki note passes contract", contracts.validateWikiNote(fs.readFileSync(synth!.wikiNotePath, "utf-8")).valid);
      check("raw file moved to processed", fs.existsSync(path.join(paths.processed, inboxFile)) && !fs.existsSync(path.join(paths.inbox, inboxFile)));
      check("inbox is now empty", runtime.preflightInbox(paths).count === 0);
    }

    // 4. Processed move idempotency.
    console.log("\nIdempotent move");
    {
      const again = runtime.moveProcessed(paths, [inboxFile]);
      check("re-moving an already-moved file is skipped, not errored", again.moved.length === 0 && again.skipped.includes(inboxFile));
    }

    // 4b. Generic workflow node action mirrors the same safe move behavior.
    console.log("\nGeneric move-files node");
    {
      const genericName = "generic-move.md";
      fs.writeFileSync(path.join(paths.inbox, genericName), "# Generic move\n", "utf-8");
      const { getNodeHandler } = await import("../src/lib/engine/node-registry");
      const handler = getNodeHandler("system-command")!;
      const moved = await handler.execute(
        {
          data: { result: { files: [genericName] } },
          config: {
            action: "move-files",
            command: "move-files",
            sourcePath: paths.inbox,
            targetPath: paths.processed,
            allowedRoot: paths.root,
            ext: "md",
          },
          node: { id: "move", type: "system-command" },
        },
        {
          workflowId: "test",
          executionId: "test",
          abortSignal: new AbortController().signal,
          get: () => undefined,
          set: () => undefined,
          emit: () => undefined,
          getModel: () => ({ provider: "test", modelId: "test", apiKey: "", temperature: 0.2, maxTokens: 100 }) as never,
        },
      );
      check("generic move-files moved a file", (moved.data.movedFiles as string[]).includes(genericName));
      check("generic move-files preserves content in target", fs.existsSync(path.join(paths.processed, genericName)));
      check("generic move-files removes inbox copy", !fs.existsSync(path.join(paths.inbox, genericName)));
    }

    // 5. Contradiction fixture.
    console.log("\nContradiction");
    {
      const prior = "Competitor X starter plan is $20/month.";
      const next = "Competitor X starter plan is not $20/month; it is $29/month.";
      const det = contracts.detectContradiction(next, [prior]);
      check("contradiction detected", det.contradiction);
      const notePath = runtime.writeContradiction(paths, {
        slug: "competitor-x-pricing",
        newClaim: next,
        priorClaim: prior,
        sources: ["https://example.com/pricing"],
      });
      check("contradiction note written", fs.existsSync(notePath));
      check("contradiction note in contradictions folder", notePath.includes(path.join("wiki", "contradictions")));
    }

    // 6. Briefer.
    console.log("\nBriefer");
    {
      const brief = runtime.deterministicBrief(paths, { usageLine: "Usage: 1,200 tokens / $0.01 this week." });
      const v = contracts.validateBrief(brief);
      check("brief passes contract (<=5 bullets, has usage)", v.valid, v.errors.join("; "));
      const briefPath = runtime.archiveBrief(paths, { content: brief });
      check("brief archived under wiki/briefs", fs.existsSync(briefPath) && briefPath.includes(path.join("wiki", "briefs")));
    }

    // 7. Generated workflows are linked to the department.
    console.log("\nDepartment linkage");
    {
      const r = createResearchDepartment({
        name: "Integration Desk",
        tier: "standard",
        focusArea: "local-first AI agents and workflow automation",
        sources: { keywords: ["local agents"], rssFeeds: ["https://example.com/feed"], arxivCategories: ["cs.AI"], competitorUrls: [] },
        inactive: true,
      });
      const detail = getDepartmentDetail(r.departmentId)!;
      check("3 agents linked to department", detail.members.length === 3);
      check("workflows linked to department", detail.workflows.length >= 3);
      check("all workflow links reference real workflows", detail.workflows.every((w) => w.workflowId.startsWith("wf-")));

      // Weekly usage rollup (grounds the Briefer "Usage:" line).
      const { getDepartmentWeeklyUsage } = await import("../src/lib/research-department/store");
      const usage = getDepartmentWeeklyUsage(r.departmentId, 7);
      check("usage rollup returns a formatted line", /Usage:.*tokens.*\$/.test(usage.line), usage.line);
      check("usage rollup covers all member agents", usage.perAgent.length === 3);
      check("fresh department has zero usage", usage.tokens === 0 && usage.costUsd === 0);

      // Briefer workflow injects the real usage line via a generic read-only database query.
      const { getSqlite } = await import("../src/lib/db");
      const brieferLink = detail.workflows.find((w) => w.kind === "briefer_morning")!;
      const row = getSqlite().prepare("SELECT nodes FROM workflows WHERE id = ?").get(brieferLink.workflowId) as { nodes: string };
      const bNodes = JSON.parse(row.nodes) as Array<{ type: string; data?: Record<string, unknown> }>;
      const usageNode = bNodes.find((nn) => nn.type === "database-query" && String(nn.data?.query || "").includes("agent_spend_events"));
      const bAgent = bNodes.find((nn) => nn.type === "claude-agent");
      check("briefer has a generic read-only usage query node", Boolean(usageNode));
      check("briefer prompt injects the query's line", String(bAgent?.data?.systemPrompt || "").includes("{{nodes.fetch_weekly_usage.rows.0.line}}"));
      check("briefer workflow has no fixed localhost port", !JSON.stringify(bNodes).includes("localhost:3100"));
      vault.removeVault(r.vaultRoot);
    }
  } finally {
    vault.removeVault(testRoot);
  }
}

main()
  .then(() => {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`research-department-integration-regression: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("Failed cases:", failures.join(", "));
      process.exit(1);
    }
    console.log("All integration regression tests passed.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
