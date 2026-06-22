import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDesktopReleaseManifest } from "./desktop-release-manifest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-release-manifest-"));

try {
  const artifacts: Record<string, string> = {
    "disp8ch AI-Setup-1.0.0-x64.exe": "windows installer",
    "disp8ch AI-1.0.0-arm64.dmg": "mac dmg",
    "disp8ch AI-1.0.0-x64.AppImage": "linux appimage",
    "latest.yml": "version: 1.0.0\n",
  };
  for (const [file, content] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(tempRoot, file), content, "utf8");
  }
  fs.mkdirSync(path.join(tempRoot, "win-unpacked"));
  fs.writeFileSync(path.join(tempRoot, "win-unpacked", "disp8ch AI.exe"), "unpacked exe should not be in release manifest", "utf8");

  const manifest = buildDesktopReleaseManifest({
    distDir: tempRoot,
    channel: "stable",
    baseUrl: "https://downloads.example.com/disp8ch",
    generatedAt: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.channel, "stable");
  assert.equal(manifest.artifacts.length, 4);
  assert(!manifest.artifacts.some((artifact) => artifact.file.includes("win-unpacked")));

  const win = manifest.artifacts.find((artifact) => artifact.file.endsWith(".exe"));
  assert(win);
  assert.equal(win.platform, "win32");
  assert.equal(win.type, "nsis");
  assert.equal(win.arch, "x64");
  assert.equal(win.url, "https://downloads.example.com/disp8ch/disp8ch%20AI-Setup-1.0.0-x64.exe");
  assert.equal(win.sha256, crypto.createHash("sha256").update("windows installer").digest("hex"));

  const mac = manifest.artifacts.find((artifact) => artifact.file.endsWith(".dmg"));
  assert(mac);
  assert.equal(mac.platform, "darwin");
  assert.equal(mac.arch, "arm64");

  const linux = manifest.artifacts.find((artifact) => artifact.file.endsWith(".AppImage"));
  assert(linux);
  assert.equal(linux.platform, "linux");
  assert.equal(linux.type, "appimage");

  const latest = manifest.artifacts.find((artifact) => artifact.file === "latest.yml");
  assert(latest);
  assert.equal(latest.platform, "metadata");

  console.log("desktop-release-manifest-regression: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
