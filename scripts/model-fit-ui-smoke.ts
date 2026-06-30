import { chromium } from "playwright";

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

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await page.goto(`${BASE_URL}/settings?tab=models`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('[data-perf-ready="settings"]').waitFor({ state: "visible", timeout: 30_000 });

    const advisorHeading = page.getByText("Find a local model for this PC", { exact: true }).last();
    await advisorHeading.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
    check("advisor visible", await advisorHeading.isVisible().catch(() => false));

    const checkButton = page.getByRole("button", { name: "Check this PC", exact: true }).last();
    await checkButton.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
    check("advisor starts on demand", await checkButton.isVisible().catch(() => false));
    await page.getByLabel("Preference").selectOption("speed");
    await checkButton.click();

    const fillForm = page.getByRole("button", { name: "Fill provider form", exact: true }).first();
    await fillForm.waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
    check("recommendations rendered (lanes)", await fillForm.isVisible().catch(() => false));
    check("best quality lane shown", await page.getByText("Best quality", { exact: true }).first().isVisible().catch(() => false));
    check("fastest useful lane shown", await page.getByText("Fastest useful", { exact: true }).first().isVisible().catch(() => false));
    check("preference changes lane order", await page.locator("[data-model-fit-lane]").first().getAttribute("data-model-fit-lane") === "fast");
    check("inventory-first section shown", await page.getByText("Models already on this PC", { exact: true }).first().isVisible().catch(() => false));
    check("honest confidence wording shown", await page.getByText(/Estimated by llama\.cpp|Measured on this PC|Estimated from model metadata/i).first().isVisible().catch(() => false));
    check("optional benchmark action shown", await page.getByRole("button", { name: "Benchmark on this PC", exact: true }).first().isVisible().catch(() => false));
    check("configured model review action shown", await page.getByRole("button", { name: "Test and review", exact: true }).first().isVisible().catch(() => false));
    const pageText = await page.content();
    check("no mojibake in output", !/�/.test(pageText));

    await fillForm.click();
    check(
      "picker states no-side-effect boundary",
      await page.getByText(/never downloads, starts, or activates a model/i).isVisible().catch(() => false),
    );
    if (process.env.SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
    }
  } finally {
    await browser.close();
  }

  console.log(`model-fit-ui-smoke: ${passed}/${passed + failed} passed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
