#!/usr/bin/env tsx

import { chromium, type Locator, type Page } from "playwright";
import { listBackgroundJobs, spawnBackgroundJob } from "@/lib/runtime/background-jobs";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");

type Check = { name: string; passed: boolean; detail?: string };
const checks: Check[] = [];
function check(name: string, passed: unknown, detail?: string) {
  checks.push({ name, passed: Boolean(passed), detail });
}

async function waitForClientPage(page: Page, marker: string) {
  await page.locator(`[data-perf-ready="${marker}"]:not([aria-busy="true"])`).waitFor({ state: "visible", timeout: 60_000 });
}

async function overflowDetail(locator: Locator) {
  return locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
}

async function waitForCompletedJob(sessionId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = listBackgroundJobs({ sessionId, limit: 1 })[0];
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Background UI fixture did not complete");
}

async function main() {
  const sessionId = `release-ui-${Date.now()}`;
  const job = spawnBackgroundJob({
    toolName: "bash_exec",
    commandPreview: "release UI background fixture",
    spawnCommand: process.env.ComSpec || "cmd.exe",
    spawnArgs: ["/d", "/s", "/c", "echo BG_UI_OK"],
    sessionId,
    agentId: null,
    notifyOnComplete: true,
  });
  await waitForCompletedJob(sessionId);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  try {
    await page.goto(`${BASE_URL}/scheduler`, { waitUntil: "domcontentloaded" });
    await waitForClientPage(page, "scheduler");
    await page.getByRole("button", { name: "Create automation", exact: true }).first().click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "Create automation" }).waitFor({ state: "visible" });
    check("guided automation opens", await dialog.getByRole("button", { name: "Guided", exact: true }).isVisible());

    const selects = dialog.locator("select");
    await selects.first().selectOption("interval");
    check("interval cadence exposes bounded choices", await dialog.getByText("Repeat every", { exact: true }).isVisible() && await dialog.locator("select").nth(1).locator('option[value="5"]').count() === 1);
    await selects.first().selectOption("one-time");
    check("one-time cadence exposes date", await dialog.getByText("Date", { exact: true }).isVisible());
    await dialog.locator("select").last().selectOption("telegram");
    check("external delivery requires destination", await dialog.getByPlaceholder("123456789").isVisible());
    check("retry and overlap controls visible", await dialog.getByText("Retry once on failure", { exact: true }).isVisible() && await dialog.getByText("Allow overlapping runs", { exact: true }).isVisible());
    const desktopDialog = await overflowDetail(dialog);
    check("automation dialog has no desktop horizontal overflow", desktopDialog.scrollWidth <= desktopDialog.clientWidth + 1, JSON.stringify(desktopDialog));
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Create automation", exact: true }).first().click();
    dialog = page.getByRole("dialog");
    const mobileDialog = await overflowDetail(dialog);
    check("automation dialog has no mobile horizontal overflow", mobileDialog.scrollWidth <= mobileDialog.clientWidth + 1, JSON.stringify(mobileDialog));
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.goto(`${BASE_URL}/skills`, { waitUntil: "domcontentloaded" });
    await waitForClientPage(page, "skills");
    await page.getByRole("button", { name: "Browse skills", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Search bundled + optional skills…").waitFor({ state: "visible" });
    const catalogButtons = dialog.locator("button").filter({ hasText: /bundled|optional/i });
    await catalogButtons.first().waitFor({ state: "visible" });
    check("skill catalog lists local sources", await catalogButtons.count() > 0);
    const previewResponse = page.waitForResponse((response) => response.url().includes("/api/skills/catalog?name=") && response.url().includes("source="));
    await catalogButtons.first().click();
    await previewResponse;
    check("skill preview is source-qualified", await dialog.getByText(/Files \(\d+\):/).isVisible());
    check("mobile skill preview has Back control", await dialog.getByRole("button", { name: "Back to skills" }).isVisible());
    const skillDialog = await overflowDetail(dialog);
    check("skill catalog has no mobile horizontal overflow", skillDialog.scrollWidth <= skillDialog.clientWidth + 1, JSON.stringify(skillDialog));
    await dialog.getByRole("button", { name: "Back to skills" }).click();
    check("Back returns to skill list", await catalogButtons.first().isVisible());
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${BASE_URL}/activity`, { waitUntil: "domcontentloaded" });
    await waitForClientPage(page, "activity");
    const backgroundCard = page.getByText("Background subagents", { exact: false }).first();
    await backgroundCard.waitFor({ state: "visible" });
    await backgroundCard.click();
    check("recent background work is visible in Activity", await page.getByText("release UI background fixture", { exact: true }).first().isVisible());
    const conversation = page.getByRole("link", { name: "Conversation", exact: true }).first();
    check("Activity conversation link uses sessionId", (await conversation.getAttribute("href")) === `/chat?sessionId=${encodeURIComponent(sessionId)}`);
    await conversation.click();
    await page.waitForURL((url) => url.pathname === "/chat" && url.searchParams.get("sessionId") === sessionId);
    await waitForClientPage(page, "chat");
    await page.getByText("BG_UI_OK", { exact: false }).first().waitFor({ state: "visible" });
    check("chat deep link restores background completion", await page.getByText("BG_UI_OK", { exact: false }).first().isVisible());
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  for (const item of checks) {
    console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` :: ${item.detail}` : ""}`);
  }
  const passed = checks.filter((item) => item.passed).length;
  console.log(`\nrelease-gap-ui-smoke: ${passed}/${checks.length} passed (fixture ${job.id})`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
