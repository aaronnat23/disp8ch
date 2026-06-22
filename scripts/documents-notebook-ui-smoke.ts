#!/usr/bin/env tsx
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { nanoid } from "nanoid";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3100";
const SCREENSHOT_DIR = path.resolve(process.env.SCREENSHOT_DIR || "screenshots/documents-notebook-ui");

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];

function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function json(pathname: string, method = "GET", body?: unknown) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed, text };
}

function b64(text: string) {
  return Buffer.from(text, "utf8").toString("base64");
}

async function main() {
  console.log(`\ndocuments-notebook-ui-smoke against ${BASE_URL}\n`);
  const suffix = nanoid(6);
  let notebookId = "";
  let documentId = "";
  const fileName = `ui-notebook-source-${suffix}.md`;
  const notebookName = `UI Notebook ${suffix}`;

  const upload = await json("/api/documents", "POST", {
    action: "upload",
    fileName,
    mimeType: "text/markdown",
    contentBase64: b64("UI notebook source says Project Lyra uses amber citations for notebook answers."),
  });
  documentId = upload.body?.data?.id || "";
  check("seed document upload", upload.status === 201 && Boolean(documentId), upload.text);

  const notebook = await json("/api/notebooks", "POST", { name: notebookName });
  notebookId = notebook.body?.data?.id || "";
  check("seed notebook create", notebook.status === 201 && Boolean(notebookId), notebook.text);

  const membership = await json(`/api/notebooks/${notebookId}`, "POST", {
    action: "add-document",
    documentId,
    contextMode: "summary",
  });
  check("seed notebook source", membership.ok, membership.text);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}/documents`, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (page.url().includes("/offline")) {
      await page.goto(`${BASE_URL}/documents`, { waitUntil: "networkidle", timeout: 60000 });
    }
    await page.getByRole("heading", { name: "Data Sources", exact: true }).waitFor({ state: "visible", timeout: 60000 });
    check("documents page renders", await page.getByText("Manage source material here. Ask and reason over it from WebChat.").isVisible());

    await page.getByRole("button", { name: /Notebooks/i }).click();
    await page.getByText(notebookName, { exact: false }).waitFor({ state: "visible", timeout: 30000 });
    check("notebooks tab shows seeded notebook", await page.getByText(notebookName, { exact: false }).isVisible());
    check("notebooks tab shows preview control", await page.getByText("Preview citations", { exact: false }).isVisible());
    check("notebooks tab shows WebChat handoff", await page.getByRole("button", { name: /Ask in WebChat/i }).isVisible());
    check(
      "notebooks tab shows source columns",
      await page.getByText("Notebook Sources", { exact: false }).first().isVisible() &&
        await page.getByRole("heading", { name: "Library Sources", exact: true }).isVisible(),
    );
    check("notebooks tab shows output actions", await page.getByRole("button", { name: /Mind Map/i }).isVisible() && await page.getByRole("button", { name: /Audio Script/i }).isVisible());
    check("notebooks tab shows source file", await page.getByText(fileName, { exact: false }).isVisible());

    await page.getByPlaceholder("Preview which notebook sources match a question").fill("What citation color does Lyra use?");
    const askResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/notebooks/${notebookId}`) &&
      response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await askResponse;
    await page.getByText("Evidence found for:", { exact: false }).waitFor({ state: "visible", timeout: 30000 });
    check(
      "notebook UI ask returns cited answer",
      await page.getByText("Evidence found for:", { exact: false }).isVisible() &&
        await page.getByText("amber citations", { exact: false }).first().isVisible() &&
        await page.getByText(`${fileName} §`, { exact: false }).isVisible(),
    );

    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const screenshotPath = path.join(SCREENSHOT_DIR, `documents-notebook-${suffix}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    check("notebook UI screenshot captured", true, screenshotPath);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close();
    if (notebookId) await json(`/api/notebooks/${notebookId}`, "DELETE").catch(() => undefined);
    if (documentId) await json(`/api/documents/${documentId}`, "DELETE").catch(() => undefined);
  }

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
