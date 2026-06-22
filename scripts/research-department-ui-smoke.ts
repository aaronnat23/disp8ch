/**
 * Research Department UI smoke (needs a running server + playwright).
 *
 * Opens the Research Team drawer inside Hierarchy, drives the wizard to create
 * a Standard team, confirms the review screen lists the created objects, creates
 * it, runs a test-run, and checks the agents/workflows links render. Cleans up via API.
 *
 *   set BASE_URL=http://127.0.0.1:3100&& pnpm.cmd exec tsx scripts\research-department-ui-smoke.ts
 */
import { chromium, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3100";
const RUN_ID = Date.now();

type Check = { name: string; passed: boolean; detail?: string };
function record(checks: Check[], name: string, passed: unknown, detail?: string) {
  checks.push({ name, passed: Boolean(passed), detail });
}

async function clickText(page: Page, text: string) {
  await page.getByRole("button", { name: text, exact: false }).first().click();
}

async function main() {
  const checks: Check[] = [];
  let createdId = "";
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(`${BASE_URL}/research-department`, { waitUntil: "networkidle" });
    await page.locator('[data-perf-ready="hierarchy"]:not([aria-busy="true"])').waitFor({ state: "visible", timeout: 30_000 });
    const legacyDestination = new URL(page.url());
    record(
      checks,
      "legacy route redirects into Hierarchy",
      legacyDestination.pathname === "/hierarchy" && legacyDestination.searchParams.get("panels")?.split(",").includes("research"),
      page.url(),
    );
    record(checks, "research team drawer opens", await page.getByRole("heading", { name: "Research Team", exact: true }).isVisible().catch(() => false));
    record(checks, "sidebar has no separate research destination", (await page.locator('a[href="/research-department"]').count()) === 0);

    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForTimeout(250);
    const closedDestination = new URL(page.url());
    record(checks, "closing drawer clears its URL marker", !closedDestination.searchParams.get("panels")?.split(",").includes("research"), page.url());
    record(checks, "research team drawer closes", !(await page.getByRole("heading", { name: "Research Team", exact: true }).isVisible().catch(() => false)));
    await clickText(page, "Research Team");
    record(checks, "header reopens research team drawer", await page.getByRole("heading", { name: "Research Team", exact: true }).isVisible().catch(() => false));

    await clickText(page, "Create Research Team");
    record(checks, "wizard opens (tier step)", await page.getByText("Recommended", { exact: false }).first().isVisible().catch(() => false));

    // Tier: Standard is default; advance through steps.
    await clickText(page, "Standard");
    await clickText(page, "Next"); // -> Focus & Sources
    // fill a unique name
    const nameInput = page.locator("#research-team-name");
    await nameInput.fill(`UI Smoke Desk ${RUN_ID}`);
    await clickText(page, "Next"); // -> Delivery & Vault
    await clickText(page, "Next"); // -> Safety & Review
    record(checks, "review screen lists agents", await page.getByText("Scout, Analyst, Briefer", { exact: false }).first().isVisible().catch(() => false));

    await clickText(page, "Create Research Team");
    await page.waitForTimeout(4000);

    // The new card should render with the test-run button.
    record(checks, "department card rendered", await page.getByText(`UI Smoke Desk ${RUN_ID}`, { exact: false }).first().isVisible().catch(() => false));
    record(checks, "test-run button present", await page.getByRole("button", { name: "Test Run", exact: false }).first().isVisible().catch(() => false));

    // Find the created department id via API for cleanup + assertions.
    const list = await fetch(`${BASE_URL}/api/research-departments`).then((r) => r.json());
    const found = (list.data || []).find((d: { name: string; id: string }) => d.name === `UI Smoke Desk ${RUN_ID}`);
    createdId = found?.id || "";
    record(checks, "department persisted via API", Boolean(createdId));

    await clickText(page, "Test Run");
    await page.waitForTimeout(3000);
    record(checks, "run summary shows zero model calls", await page.getByText("0 model calls", { exact: false }).first().isVisible().catch(() => false));
  } catch (error) {
    const body = await page.locator("body").innerText().catch(() => "");
    record(checks, "no exceptions", false, `${String(error)} | browser=${browserErrors.join(" | ")} | body=${body.slice(0, 500)}`);
  } finally {
    if (createdId) {
      await fetch(`${BASE_URL}/api/research-departments/${createdId}?deleteVault=1`, { method: "DELETE" }).catch(() => {});
    }
    await browser.close();
  }

  let passed = 0;
  for (const c of checks) {
    if (c.passed) {
      passed++;
      console.log(`PASS ${c.name}`);
    } else {
      console.error(`FAIL ${c.name}${c.detail ? ` :: ${c.detail}` : ""}`);
    }
  }
  console.log(`\nresearch-department-ui-smoke: ${passed}/${checks.length} passed`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exitCode = 1;
});
