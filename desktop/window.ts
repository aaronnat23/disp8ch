import path from "node:path";
import fs from "node:fs";
import { BrowserWindow, app, shell, type WebContents } from "electron";
import { classifyNavigation, desktopContentSecurityPolicy } from "./security";

function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "assets", "icon.png"),
    path.join(app.getAppPath(), ".desktop", "assets", "icon.png"),
    path.resolve(process.cwd(), "desktop", "assets", "icon.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Apply navigation hardening to a WebContents: deny unexpected in-app
 * navigation, route external links through the OS browser, and forbid
 * arbitrary window creation. `getRuntimeOrigin` resolves the current trusted
 * runtime origin (it may be null before the runtime has started).
 */
export function hardenWebContents(
  contents: WebContents,
  getRuntimeOrigin: () => string | null,
): void {
  contents.on("will-navigate", (event, url) => {
    const decision = classifyNavigation(url, getRuntimeOrigin());
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") {
      void shell.openExternal(url);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    const decision = classifyNavigation(url, getRuntimeOrigin());
    if (decision === "external") {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  contents.on("will-attach-webview", (event) => {
    // No embedded <webview> tags are expected; block them entirely.
    event.preventDefault();
  });

  contents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [desktopContentSecurityPolicy(getRuntimeOrigin())],
      },
    });
  });
}

export function createMainWindow(getRuntimeOrigin: () => string | null): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: "disp8ch",
    backgroundColor: "#0b1020",
    icon: resolveAppIconPath(),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      preload: path.join(app.getAppPath(), ".desktop", "preload.cjs"),
    },
  });

  hardenWebContents(window.webContents, getRuntimeOrigin);
  window.once("ready-to-show", () => window.show());
  return window;
}

export function createSessionWindow(getRuntimeOrigin: () => string | null): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 420,
    minHeight: 480,
    title: "disp8ch — session",
    backgroundColor: "#0b1020",
    icon: resolveAppIconPath(),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      preload: path.join(app.getAppPath(), ".desktop", "preload.cjs"),
    },
  });
  hardenWebContents(window.webContents, getRuntimeOrigin);
  window.once("ready-to-show", () => window.show());
  return window;
}

export function loadingHtml(message = "Starting disp8ch..."): string {
  return [
    "<!doctype html>",
    "<meta charset=\"utf-8\" />",
    "<title>disp8ch</title>",
    "<body style=\"margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:100vh\">",
    "<main style=\"max-width:560px;padding:32px;text-align:center\">",
    "<h1 style=\"font-size:22px;margin:0 0 12px\">disp8ch</h1>",
    `<p style="color:#94a3b8;line-height:1.6">${message}</p>`,
    "</main>",
    "</body>",
  ].join("");
}

export function failureHtml(message: string): string {
  return loadingHtml(`Startup failed. ${message.replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char] || char))}`);
}
