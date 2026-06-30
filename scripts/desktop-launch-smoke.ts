import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const mainBundle = path.join(root, ".desktop", "main.cjs");
const preloadBundle = path.join(root, ".desktop", "preload.cjs");
const wsBundle = path.join(root, ".desktop", "ws-server.cjs");
const builderConfig = path.join(root, "electron-builder.yml");
const stagedRuntime = path.join(root, ".desktop-runtime");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  main?: string;
  scripts?: Record<string, string>;
};

assert.equal(packageJson.main, ".desktop/main.cjs");
assert(packageJson.scripts?.["desktop:build"]);
assert(packageJson.scripts?.["desktop:pack"]);
assert(packageJson.scripts?.["desktop:dist"]);
assert(fs.existsSync(mainBundle), "desktop main bundle missing; run pnpm desktop:build");
assert(fs.existsSync(preloadBundle), "desktop preload bundle missing; run pnpm desktop:build");
assert(fs.existsSync(wsBundle), "desktop websocket sidecar bundle missing; run pnpm desktop:build");
assert(fs.existsSync(builderConfig), "electron-builder.yml missing");
assert(fs.existsSync(path.join(stagedRuntime, ".next", "standalone", "server.js")), "staged standalone server missing; run pnpm desktop:stage");
assert(fs.existsSync(path.join(stagedRuntime, ".next", "standalone", ".next", "static")), "staged Next static assets missing");
assert(fs.existsSync(path.join(stagedRuntime, ".next", "standalone", "node_modules", "styled-jsx", "package.json")), "staged standalone runtime missing styled-jsx");
assert(fs.existsSync(path.join(stagedRuntime, ".next", "standalone", "node_modules", "@swc", "helpers", "package.json")), "staged standalone runtime missing @swc/helpers");
assert(fs.existsSync(path.join(stagedRuntime, ".desktop", "ws-server.cjs")), "staged desktop websocket sidecar missing");
assert(!fs.existsSync(path.join(stagedRuntime, ".next", "standalone", ".env.local")), "staged runtime must not include .env.local");
assert(!fs.existsSync(path.join(stagedRuntime, ".next", "standalone", "data")), "staged runtime must not include repo-local data/");
assert(!fs.existsSync(path.join(stagedRuntime, ".next", "standalone", "docs", "improvements")), "staged runtime must not include benchmark/improvement artifacts");

const config = fs.readFileSync(builderConfig, "utf8");
assert(config.includes("nsis"), "Windows NSIS target missing");
assert(config.includes("dmg"), "macOS DMG target missing");
assert(config.includes("AppImage"), "Linux AppImage target missing");
assert(config.includes(".desktop-runtime"), "electron-builder must use sanitized desktop runtime stage");
assert(!config.includes(".next/standalone/**"), "electron-builder must not package raw .next/standalone directly");
assert(!/^\s*publish\s*:/m.test(config), "electron-builder publish metadata must stay external to local unsigned builds");
assert(!/^\s*-\s+data\//m.test(config), "desktop config must not bundle repo-local data/");
assert(!/\.env\.local/.test(config), "desktop config must not bundle .env.local");

console.log("desktop-launch-smoke: ok");
