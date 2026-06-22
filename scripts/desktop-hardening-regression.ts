#!/usr/bin/env tsx
/**
 * Phase 0 desktop hardening regression.
 *
 * Verifies the pure security classifiers and statically asserts that the
 * Electron shell wiring (window/main/preload/tray) keeps its hardening
 * guarantees. Electron-importing modules are checked by source inspection so
 * this can run headless inside test:release.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalChannel,
  classifyNavigation,
  desktopContentSecurityPolicy,
  isTrustedIpcSender,
  resolveDesktopEnv,
} from "../desktop/security";
import { resolveDesktopUpdateConfig } from "../desktop/update";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

const runtimeOrigin = "http://127.0.0.1:3100";

// --- resolveDesktopEnv precedence ---
check(
  "env.prefersDisp8chDesktop",
  resolveDesktopEnv("APP_ROOT", {
    DISP8CH_DESKTOP_APP_ROOT: "new",
    DISP8CH_APP_ROOT: "fallback",
  } as NodeJS.ProcessEnv) === "new",
);
check(
  "env.generalFallback",
  resolveDesktopEnv("APP_ROOT", { DISP8CH_APP_ROOT: "fallback" } as NodeJS.ProcessEnv) === "fallback",
);
check("env.undefinedWhenMissing", resolveDesktopEnv("NOPE", {} as NodeJS.ProcessEnv) === undefined);
check(
  "update.canonicalEnvResolves",
  resolveDesktopUpdateConfig({ DISP8CH_DESKTOP_UPDATE_URL: "https://x/m.json" } as NodeJS.ProcessEnv).manifestUrl ===
    "https://x/m.json",
);

// --- navigation classifier ---
check("nav.sameOriginAllow", classifyNavigation(`${runtimeOrigin}/chat`, runtimeOrigin) === "allow");
check("nav.otherHttpExternal", classifyNavigation("https://example.com/x", runtimeOrigin) === "external");
check("nav.mailtoExternal", classifyNavigation("mailto:a@b.com", runtimeOrigin) === "external");
check("nav.fileDeny", classifyNavigation("file:///etc/passwd", runtimeOrigin) === "deny");
check("nav.dataDeny", classifyNavigation("data:text/html,<script>1</script>", runtimeOrigin) === "deny");
check("nav.javascriptDeny", classifyNavigation("javascript:alert(1)", runtimeOrigin) === "deny");
check("nav.customProtocolDeny", classifyNavigation("disp8ch-evil://x", runtimeOrigin) === "deny");
check("nav.garbageDeny", classifyNavigation("not a url", runtimeOrigin) === "deny");
check(
  "nav.crossPortNotAllowedInApp",
  classifyNavigation("http://127.0.0.1:9999/x", runtimeOrigin) === "external",
);

// --- IPC sender trust ---
check("ipc.trustsRuntime", isTrustedIpcSender(`${runtimeOrigin}/onboarding`, runtimeOrigin) === true);
check("ipc.rejectsOtherOrigin", isTrustedIpcSender("https://evil.com", runtimeOrigin) === false);
check("ipc.rejectsFile", isTrustedIpcSender("file:///x", runtimeOrigin) === false);
check("ipc.rejectsEmpty", isTrustedIpcSender("", runtimeOrigin) === false);
check("ipc.rejectsWhenNoRuntime", isTrustedIpcSender(`${runtimeOrigin}/x`, null) === false);

// --- channel names ---
check("channel.canonical", canonicalChannel("get-health") === "disp8ch:get-health");

// --- CSP ---
const csp = desktopContentSecurityPolicy(runtimeOrigin);
check("csp.frameAncestorsNone", csp.includes("frame-ancestors 'none'"));
check("csp.objectSrcNone", csp.includes("object-src 'none'"));
check("csp.connectIncludesWs", csp.includes("ws://127.0.0.1:3100"));

// --- static source guarantees ---
const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const windowSrc = read("desktop/window.ts");
check("window.sandboxEnabled", /sandbox:\s*true/.test(windowSrc));
check("window.contextIsolation", /contextIsolation:\s*true/.test(windowSrc));
check("window.noNodeIntegration", /nodeIntegration:\s*false/.test(windowSrc));
check("window.webviewDisabled", /webviewTag:\s*false/.test(windowSrc));
check("window.willNavigateHandler", windowSrc.includes("will-navigate"));
check("window.windowOpenHandler", windowSrc.includes("setWindowOpenHandler"));
check("window.cspHeader", windowSrc.includes("Content-Security-Policy"));

const mainSrc = read("desktop/main.ts");
check("main.validatesSender", mainSrc.includes("isTrustedIpcSender"));
check("main.canonicalOnly", mainSrc.includes("canonicalChannel") && !mainSrc.includes("legacyChannel"));
check("main.noArbitraryPathImport", !mainSrc.includes("import-database-file"));
check("main.webContentsCreatedGuard", mainSrc.includes("web-contents-created"));

const preloadSrc = read("desktop/preload.ts");
check("preload.exposesDisp8ch", preloadSrc.includes('exposeInMainWorld("disp8chDesktop"'));
check("preload.singleBridge", preloadSrc.match(/exposeInMainWorld\("disp8chDesktop"/g)?.length === 1);
check("preload.importNoArg", /importDatabase:\s*\(\)\s*=>/.test(preloadSrc));

const traySrc = read("desktop/tray.ts");
check("tray.usesRealIcon", traySrc.includes("createFromPath") && traySrc.includes("tray-icon.png"));

const updateSrc = read("desktop/update.ts");
check("update.usesResolveDesktopEnv", updateSrc.includes("resolveDesktopEnv"));

// --- icon assets exist and are real PNGs ---
const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
for (const asset of ["tray-icon.png", "icon.png"]) {
  const file = path.join(root, "desktop", "assets", asset);
  const exists = fs.existsSync(file);
  const valid = exists && Buffer.alloc(8).fill(0).length === 8 && fs.readFileSync(file).subarray(0, 8).equals(pngSig);
  check(`asset.${asset}`, Boolean(valid), exists ? "valid png" : "missing");
}

const failed = results.filter((r) => !r.ok);
console.log(`\ndesktop-hardening-regression: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
