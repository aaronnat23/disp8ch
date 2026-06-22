import { chromium, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3100";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ""}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function open(page: Page, pathname: string): Promise<void> {
  await page.goto(`${BASE_URL}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
}

async function waitForSurface(page: Page, marker: string): Promise<void> {
  await page.locator(`[data-perf-ready="${marker}"]:not([aria-busy="true"])`).waitFor({ state: "visible", timeout: 30_000 });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

  try {
    const templateBootstrap = await fetch(`${BASE_URL}/api/workflows/bootstrap`);
    const templatePayload = await templateBootstrap.json() as { data?: { templates?: { count?: unknown } } };
    const templateTotal = Number(templatePayload.data?.templates?.count);
    check("workflow template catalog reports a positive count", templateBootstrap.ok && Number.isInteger(templateTotal) && templateTotal > 0);

    await open(page, "/council");
    await waitForSurface(page, "council");
    const councilToggle = page.getByRole("button", { name: /advanced options/i });
    check("council advanced toggle visible", await councilToggle.isVisible().catch(() => false));
    check("council advanced controls collapsed", !(await page.getByText("Decision Mode", { exact: true }).isVisible().catch(() => false)));
    check("council explains individual agent selection", await page.getByText(/pick individual agents|select individual agents/i).first().isVisible().catch(() => false));
    check("council team filter is optional", await page.getByText("Team Filter (optional)", { exact: false }).isVisible().catch(() => false));
    await councilToggle.click();
    check("council advanced controls expand", await page.getByText("Decision Mode", { exact: true }).isVisible().catch(() => false));

    await open(page, "/skills");
    await waitForSurface(page, "skills");
    check("skills page gives concise first-run guidance", await page.getByText("Start with lean capabilities", { exact: true }).isVisible().catch(() => false));
    await page.getByRole("button", { name: "Hide Tips", exact: true }).click();
    check("skills guidance can be dismissed", !(await page.getByText("Start with lean capabilities", { exact: true }).isVisible().catch(() => false)));
    check("skills guidance can be restored", await page.getByRole("button", { name: "Show Tips", exact: true }).isVisible().catch(() => false));
    check("skills and extensions have one primary capability surface", await page.getByRole("heading", { name: "Skills & Extensions", exact: true }).isVisible().catch(() => false));
    check("extension source management remains available from skills", await page.getByRole("link", { name: "Manage extension sources", exact: true }).isVisible().catch(() => false));
    check("MCP management remains available from skills", await page.getByRole("link", { name: "Manage MCP servers", exact: true }).isVisible().catch(() => false));
    check("MCP has a separate primary capability tab", await page.getByRole("link", { name: "MCP Servers", exact: true }).isVisible().catch(() => false));
    check("help remains visible outside advanced tools", await page.getByRole("link", { name: "Help & Docs", exact: true }).isVisible().catch(() => false));
    check("maintenance is visible in primary operations", await page.getByRole("link", { name: "Maintenance", exact: true }).isVisible().catch(() => false));
    const moreTools = page.getByRole("button", { name: /more tools/i });
    await moreTools.scrollIntoViewIfNeeded().catch(() => undefined);
    check("more tools navigation is visible", await moreTools.isVisible().catch(() => false));
    check("more tools navigation starts collapsed", (await moreTools.getAttribute("aria-expanded")) === "false");
    check("advanced extension route is hidden while collapsed", !(await page.getByRole("link", { name: "Extension Sources", exact: true }).isVisible().catch(() => false)));
    await moreTools.click();
    check("more tools navigation reveals advanced routes on demand", await page.getByRole("link", { name: "Extension Sources", exact: true }).isVisible().catch(() => false));
    await open(page, "/maintenance");
    await waitForSurface(page, "maintenance");
    check("maintenance no longer forces advanced tools open", (await page.getByRole("button", { name: /more tools/i }).getAttribute("aria-expanded")) === "false");

    await open(page, "/settings?tab=mcp");
    check("legacy MCP settings link redirects to the separate tab", new URL(page.url()).pathname === "/mcp", page.url());
    await waitForSurface(page, "mcp");
    check("separate MCP tab opens the MCP surface", await page.getByText("Model Context Protocol (MCP)", { exact: true }).isVisible().catch(() => false));
    if (!(await page.getByText("Who can use this server?", { exact: true }).first().isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "Add Server", exact: true }).click();
    }
    check("MCP access uses a named agent picker instead of raw IDs", await page.getByText("Who can use this server?", { exact: true }).first().isVisible().catch(() => false));
    check("MCP access defaults to all agents", await page.getByText("All agents", { exact: true }).first().isVisible().catch(() => false));
    check("MCP access offers selected-agent scoping", await page.getByText("Only selected agents", { exact: true }).first().isVisible().catch(() => false));

    await open(page, "/settings?tab=models");
    check("model settings gives concise first-run guidance", await page.getByText("Connect the model you want your agents to use.", { exact: true }).isVisible().catch(() => false));
    check("provider internals are not permanent prose", !(await page.getByText(/Tool-capable suggestions:/i).isVisible().catch(() => false)));
    check("provider details are collapsed by default", !(await page.getByText("Authentication", { exact: true }).isVisible().catch(() => false)));
    check("runtime routing controls are collapsed by default", !(await page.getByText("Enable smart routing to FAST models for simple user turns", { exact: true }).isVisible().catch(() => false)));
    await page.getByText("Provider details", { exact: true }).click();
    check("provider details remain available on demand", await page.getByText("Authentication", { exact: true }).isVisible().catch(() => false));
    await page.locator("summary").filter({ hasText: "Runtime Routing" }).click();
    check("runtime routing remains available on demand", await page.getByText("Enable smart routing to FAST models for simple user turns", { exact: true }).isVisible().catch(() => false));
    await page.getByRole("button", { name: "Hide Tips", exact: true }).click();
    const storedModelUiState = await page.evaluate(() => window.localStorage.getItem("disp8ch:model-settings-ui-state"));
    check("model guidance preference is stored", storedModelUiState?.includes('"hideGettingStarted":true') === true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Show Tips", exact: true }).waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
    check("model guidance dismissal persists", await page.getByRole("button", { name: "Show Tips", exact: true }).isVisible().catch(() => false));

    await open(page, "/memory");
    await waitForSurface(page, "memory");
    const memoryToggle = page.getByRole("button", { name: /memory health & maintenance/i });
    check("memory maintenance toggle visible", await memoryToggle.isVisible().catch(() => false));
    check("memory maintenance collapsed", !(await page.getByText("Memory Health", { exact: true }).isVisible().catch(() => false)));
    await memoryToggle.click();
    check("memory maintenance expands", await page.getByText("Memory Health", { exact: true }).isVisible().catch(() => false));

    try {
      await open(page, "/research-department");
      const researchDestination = new URL(page.url());
      check(
        "legacy research route redirects into hierarchy",
        researchDestination.pathname === "/hierarchy" && researchDestination.searchParams.get("panels")?.split(",").includes("research"),
        page.url(),
      );
      check("research team opens inside hierarchy", await page.getByRole("heading", { name: "Research Team", exact: true }).isVisible().catch(() => false));
      check("research team has no separate sidebar item", (await page.locator('a[href="/research-department"]').count()) === 0);

      await open(page, "/hierarchy");
      await waitForSurface(page, "hierarchy");
      const opsView = page.getByRole("button", { name: "Ops", exact: true });
      await opsView.click();
      const teamPreset = page.getByRole("button", { name: "Team Preset", exact: true });
      check("Hierarchy Ops exposes organization capability presets", await teamPreset.isVisible().catch(() => false));
      if (await teamPreset.isVisible().catch(() => false)) await teamPreset.click();
      check("organization capability preset drawer opens", await page.getByRole("heading", { name: "Team Capability Preset", exact: true }).isVisible().catch(() => false));
    } catch (error) {
      check("Hierarchy compatibility flow completes", false, String(error));
    }

    await open(page, "/workflows");
    await waitForSurface(page, "workflows");
    check("workflow tab reports canonical catalog size", await page.getByRole("tab", { name: new RegExp(`Templates \\(${templateTotal}\\)`, "i") }).isVisible().catch(() => false));
    check("workflow org context is optional", await page.getByText("Optional context", { exact: false }).isVisible().catch(() => false));
    check(
      "workflow gallery shows the full catalog on first load",
      await page.getByText(`Showing ${templateTotal} of ${templateTotal} templates`, { exact: false }).isVisible().catch(() => false),
    );
    check(
      "workflow gallery has no preselected intent filter",
      !(await page.getByRole("button", { name: "Show all" }).isVisible().catch(() => false)),
    );
    const chatIntent = page.getByRole("button", { name: "Answer chat messages" });
    if (await chatIntent.isVisible().catch(() => false)) await chatIntent.click();
    check("workflow filtered count is explicit", await page.getByText(new RegExp(`Showing \\d+ of ${templateTotal} templates`, "i")).isVisible().catch(() => false));
    const clearFilters = page.getByRole("button", { name: "Clear filters" });
    if (await clearFilters.isVisible().catch(() => false)) await clearFilters.click();
    check("workflow gallery restores all templates", await page.getByText(`Showing ${templateTotal} of ${templateTotal} templates`, { exact: false }).isVisible().catch(() => false));
    check("new automation recipe is visible", await page.getByText("Issue Triage Scheduler", { exact: true }).isVisible().catch(() => false));
    check("advanced crew template is visible", await page.getByText("AI Crew Orchestrator (Disp8chTeam)", { exact: true }).isVisible().catch(() => false));
  } finally {
    await browser.close();
  }

  console.log(`SUMMARY :: ${passed} passed / ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
