import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  downloadDesktopUpdate,
  evaluateDesktopUpdateManifest,
  resolveDesktopUpdateConfig,
  type DesktopUpdateManifest,
} from "../desktop/update";

const manifest: DesktopUpdateManifest = {
  schemaVersion: 1,
  appId: "app.disp8ch.desktop",
  productName: "disp8ch AI",
  version: "1.2.0",
  channel: "stable",
  generatedAt: "2026-06-01T00:00:00.000Z",
  artifacts: [
    {
      file: "disp8ch AI-Setup-1.2.0-x64.exe",
      platform: "win32",
      type: "nsis",
      arch: "x64",
      size: 10,
      sha256: "a".repeat(64),
      url: "https://downloads.example/disp8ch AI-Setup-1.2.0-x64.exe",
    },
    {
      file: "disp8ch AI-Setup-1.2.0-x64.exe.blockmap",
      platform: "metadata",
      type: "blockmap",
      arch: "unknown",
      size: 3,
      sha256: "b".repeat(64),
    },
  ],
};

assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
assert.equal(compareVersions("1.2.0", "1.3.0"), -1);

const disabled = resolveDesktopUpdateConfig({});
assert.equal(disabled.manifestUrl, "");
assert.equal(disabled.channel, "stable");

const available = evaluateDesktopUpdateManifest({
  currentVersion: "1.0.0",
  manifest,
  channel: "stable",
  platform: "win32",
  arch: "x64",
  manifestUrl: "https://downloads.example/disp8ch-release-manifest.json",
});
assert.equal(available.status, "available");
assert.equal(available.downloadAllowed, false, "desktop downloads must stay gated unless explicitly enabled");
assert.equal(available.artifact?.type, "nsis");

const current = evaluateDesktopUpdateManifest({
  currentVersion: "1.2.0",
  manifest,
  channel: "stable",
  platform: "win32",
  arch: "x64",
});
assert.equal(current.status, "current");

const wrongChannel = evaluateDesktopUpdateManifest({
  currentVersion: "1.0.0",
  manifest,
  channel: "beta",
  platform: "win32",
  arch: "x64",
});
assert.equal(wrongChannel.status, "current");
assert(wrongChannel.message.includes("channel"));

const unsupported = evaluateDesktopUpdateManifest({
  currentVersion: "1.0.0",
  manifest,
  channel: "stable",
  platform: "linux",
  arch: "arm64",
});
assert.equal(unsupported.status, "unsupported");

const downloadsAllowed = evaluateDesktopUpdateManifest({
  currentVersion: "1.0.0",
  manifest,
  channel: "stable",
  platform: "win32",
  arch: "x64",
  allowDownloads: true,
});
assert.equal(downloadsAllowed.downloadAllowed, true);

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-desktop-update-"));
  const sourceBytes = Buffer.from("verified desktop update bytes");
  const sourceSha = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  const sourcePath = path.join(tempRoot, "disp8ch AI-Setup-1.2.0-x64.exe");
  const manifestPath = path.join(tempRoot, "disp8ch-release-manifest.json");
  const downloadDir = path.join(tempRoot, "updates");
  fs.writeFileSync(sourcePath, sourceBytes);

  const downloadableManifest: DesktopUpdateManifest = {
    ...manifest,
    artifacts: [
      {
        ...manifest.artifacts[0],
        sha256: sourceSha,
        size: sourceBytes.byteLength,
        url: `file://${sourcePath.replaceAll("\\", "/")}`,
      },
    ],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(downloadableManifest));

  const downloaded = await downloadDesktopUpdate({
    currentVersion: "1.0.0",
    env: {
      DISP8CH_DESKTOP_UPDATE_URL: `file://${manifestPath.replaceAll("\\", "/")}`,
      DISP8CH_UPDATE_PLATFORM: "win32",
      DISP8CH_UPDATE_ARCH: "x64",
      DISP8CH_ENABLE_DESKTOP_UPDATE_DOWNLOADS: "1",
      DISP8CH_DESKTOP_UPDATES_DIR: downloadDir,
    },
  });
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.sha256, sourceSha);
  assert.equal(downloaded.bytes, sourceBytes.byteLength);
  assert.equal(fs.readFileSync(downloaded.filePath, "utf8"), "verified desktop update bytes");
  assert(downloaded.filePath.startsWith(downloadDir));

  await assert.rejects(
    () => downloadDesktopUpdate({
      currentVersion: "1.0.0",
      env: {
        DISP8CH_DESKTOP_UPDATE_URL: `file://${manifestPath.replaceAll("\\", "/")}`,
        DISP8CH_UPDATE_PLATFORM: "win32",
        DISP8CH_UPDATE_ARCH: "x64",
        DISP8CH_DESKTOP_UPDATES_DIR: downloadDir,
      },
    }),
    /available|download/i,
  );

  fs.writeFileSync(manifestPath, JSON.stringify({
    ...downloadableManifest,
    artifacts: [{ ...downloadableManifest.artifacts[0], sha256: "0".repeat(64) }],
  }));
  await assert.rejects(
    () => downloadDesktopUpdate({
      currentVersion: "1.0.0",
      env: {
        DISP8CH_DESKTOP_UPDATE_URL: `file://${manifestPath.replaceAll("\\", "/")}`,
        DISP8CH_UPDATE_PLATFORM: "win32",
        DISP8CH_UPDATE_ARCH: "x64",
        DISP8CH_ENABLE_DESKTOP_UPDATE_DOWNLOADS: "1",
        DISP8CH_DESKTOP_UPDATES_DIR: downloadDir,
      },
    }),
    /checksum mismatch/i,
  );
}

main()
  .then(() => console.log("desktop-update-regression: ok"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
