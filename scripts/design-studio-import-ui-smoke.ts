#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3100").trim();
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

type Check = { name: string; passed: boolean; detail?: string };
const checks: Check[] = [];

function check(name: string, passed: unknown, detail?: string) {
  checks.push({ name, passed: Boolean(passed), detail });
}

async function api(pathname: string, init?: RequestInit) {
  const response = await fetch(`${BASE_URL}${pathname}`, init);
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

async function main() {
  const stamp = Math.random().toString(36).slice(2, 8);
  const projectName = `Import UI Smoke ${stamp}`;
  const tempDir = path.join(os.tmpdir(), `disp8ch-design-import-${stamp}`);
  await mkdir(tempDir, { recursive: true });
  const imagePath = path.join(tempDir, "sample.png");
  await writeFile(imagePath, PNG_1X1);

  const project = await api("/api/design/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: projectName, description: "Temporary project for Design Studio import UI smoke." }),
  });
  check("created empty design project", project.status === 200 && project.json?.success !== false, project.text.slice(0, 240));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);

  try {
    await page.goto(`${BASE_URL}/designs`, { waitUntil: "domcontentloaded" });
    await page.getByText("Import a design, image, or source file", { exact: false }).waitFor({ state: "visible" });
    check("empty design project shows import starter", true);

    await page.getByRole("button", { name: "Upload image" }).first().click();
    await page.getByRole("dialog").getByText("Import a Design").waitFor({ state: "visible" });
    await page.locator("#design-import-image-file").setInputFiles(imagePath);
    await page.getByLabel("Design name").fill(`Uploaded Screenshot ${stamp}`);
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/api/design/projects/") && response.url().includes("/artifacts") && response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Import Design" }).click(),
    ]);

    await page.getByText(`Uploaded Screenshot ${stamp}`, { exact: false }).waitFor({ state: "visible" });
    await page.getByText("No artifact selected", { exact: false }).waitFor({ state: "detached" }).catch(() => undefined);
    const bodyText = await page.locator("body").innerText();
    check("uploaded image appears as design artifact", bodyText.includes(`Uploaded Screenshot ${stamp}`), bodyText.slice(0, 400));

    const projects = await api("/api/design/projects");
    const allProjects = Array.isArray(projects.json?.data) ? projects.json.data : [];
    let foundPersistedArtifact = false;
    for (const item of allProjects) {
      if (!item?.id) continue;
      const detail = await api(`/api/design/projects/${item.id}`);
      const artifacts = detail?.json?.data?.artifacts ?? [];
      if (Array.isArray(artifacts) && artifacts.some((artifact: any) => artifact?.title === `Uploaded Screenshot ${stamp}`)) {
        foundPersistedArtifact = true;
        break;
      }
    }
    check("uploaded image persisted through design APIs", foundPersistedArtifact, JSON.stringify(allProjects).slice(0, 300));
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const passed = checks.filter((item) => item.passed).length;
  const failed = checks.filter((item) => !item.passed);
  for (const item of checks) {
    console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` :: ${item.detail}` : ""}`);
  }
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
