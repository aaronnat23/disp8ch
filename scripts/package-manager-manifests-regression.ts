#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopReleaseManifest } from "./desktop-release-manifest";
import { buildPackageManagerManifests, writePackageManagerManifests } from "./package-manager-manifests";

const manifest: DesktopReleaseManifest = {
  schemaVersion: 1,
  appId: "app.disp8ch.desktop",
  productName: "disp8ch AI",
  version: "1.2.3",
  channel: "stable",
  generatedAt: "2026-06-02T00:00:00.000Z",
  artifacts: [
    {
      file: "disp8ch AI-Setup-1.2.3-x64.exe",
      platform: "win32",
      type: "nsis",
      arch: "x64",
      size: 123,
      sha256: "a".repeat(64),
      url: "https://downloads.example.com/disp8ch/disp8ch AI-Setup-1.2.3-x64.exe",
    },
    {
      file: "disp8ch AI-1.2.3-arm64.dmg",
      platform: "darwin",
      type: "dmg",
      arch: "arm64",
      size: 456,
      sha256: "b".repeat(64),
      url: "https://downloads.example.com/disp8ch/disp8ch AI-1.2.3-arm64.dmg",
    },
    {
      file: "disp8ch AI-1.2.3-x64.AppImage",
      platform: "linux",
      type: "appimage",
      arch: "x64",
      size: 789,
      sha256: "c".repeat(64),
      url: "https://downloads.example.com/disp8ch/disp8ch AI-1.2.3-x64.AppImage",
    },
  ],
};

const files = buildPackageManagerManifests(manifest);
const wingetInstaller = files["winget/disp8ch AI/disp8ch AI/1.2.3/disp8ch AI.disp8ch AI.installer.yaml"] ?? "";
const wingetLocale = files["winget/disp8ch AI/disp8ch AI/1.2.3/disp8ch AI.disp8ch AI.locale.en-US.yaml"] ?? "";
const cask = files["homebrew/Casks/disp8ch.rb"] ?? "";

assert(wingetInstaller.includes("PackageIdentifier: disp8ch AI.disp8ch AI"));
assert(wingetInstaller.includes("InstallerType: nullsoft"));
assert(wingetInstaller.includes("Scope: user"));
assert(wingetInstaller.includes("InstallerUrl: https://downloads.example.com/disp8ch/disp8ch AI-Setup-1.2.3-x64.exe"));
assert(wingetInstaller.includes(`InstallerSha256: ${"A".repeat(64)}`));
assert(wingetLocale.includes("ShortDescription: Local-first agent workspace"));
assert(cask.includes('cask "disp8ch" do'));
assert(cask.includes('version "1.2.3"'));
assert(cask.includes(`sha256 "${"b".repeat(64)}"`));
assert(cask.includes('url "https://downloads.example.com/disp8ch/disp8ch AI-1.2.3-arm64.dmg"'));
assert(cask.includes('app "disp8ch AI.app"'));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-package-manifests-"));
try {
  const manifestPath = path.join(tempRoot, "disp8ch-release-manifest.json");
  const outDir = path.join(tempRoot, "out");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const written = writePackageManagerManifests({ manifestPath, outDir });
  assert(written.length >= 5);
  assert(fs.existsSync(path.join(outDir, "winget", "disp8ch AI", "disp8ch AI", "1.2.3", "disp8ch AI.disp8ch AI.yaml")));
  assert(fs.existsSync(path.join(outDir, "homebrew", "Casks", "disp8ch.rb")));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const missingUrlManifest: DesktopReleaseManifest = {
  ...manifest,
  artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, url: undefined })),
};
assert.throws(
  () => buildPackageManagerManifests(missingUrlManifest),
  /missing a public URL/,
);

const windowsOnlyFiles = buildPackageManagerManifests({
  ...manifest,
  artifacts: manifest.artifacts.filter((artifact) => artifact.platform === "win32"),
});
assert(windowsOnlyFiles["winget/disp8ch AI/disp8ch AI/1.2.3/disp8ch AI.disp8ch AI.installer.yaml"]);
assert(!windowsOnlyFiles["homebrew/Casks/disp8ch.rb"]);
assert(windowsOnlyFiles["README.md"].includes("Homebrew Cask skipped"));

console.log("package-manager-manifests-regression: ok");
