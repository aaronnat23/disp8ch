import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("desktop-installer-smoke: skipped (Windows-only NSIS smoke)");
  process.exit(0);
}

const root = process.cwd();
const distDir = path.join(root, "dist", "desktop");

function findInstaller(): string {
  if (!fs.existsSync(distDir)) throw new Error(`Desktop dist directory missing at ${distDir}`);
  const installers = fs.readdirSync(distDir)
    .filter((file) => /^disp8ch AI-Setup-.*-x64\.exe$/i.test(file))
    .map((file) => path.join(distDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!installers[0]) throw new Error(`No disp8ch AI NSIS installer found in ${distDir}`);
  return installers[0];
}

function waitForHealth(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, { timeout: 2500 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
            resolve(body);
            return;
          }
          retry(`HTTP ${res.statusCode || "unknown"}`);
        });
      });
      req.on("timeout", () => {
        req.destroy();
        retry("timeout");
      });
      req.on("error", (error) => retry(error.message));
    };
    const retry = (last: string) => {
      if (Date.now() >= deadline) {
        reject(new Error(`Installed app health did not become ready: ${last}`));
        return;
      }
      setTimeout(poll, 1500);
    };
    poll();
  });
}

function taskkillDisp8ch() {
  spawnSync("taskkill.exe", ["/IM", "disp8ch AI.exe", "/F", "/T"], { stdio: "ignore" });
}

function runInstaller(installer: string, installDir: string) {
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  const command = [
    `$p = Start-Process -FilePath ${JSON.stringify(installer)} -ArgumentList @('/S', '/D=${installDir.replace(/'/g, "''")}') -Wait -PassThru`,
    "exit $p.ExitCode",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    cwd: path.dirname(installer),
    stdio: "inherit",
    timeout: 240000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `installer exited with ${result.status}`);
}

async function launchAndCheck(installDir: string): Promise<ChildProcess> {
  const exe = path.join(installDir, "disp8ch AI.exe");
  assert(fs.existsSync(exe), `installed app missing at ${exe}`);
  const child = spawn(exe, [], { cwd: installDir, stdio: "ignore" });
  const body = await waitForHealth("http://127.0.0.1:3100/api/health", 120000);
  const parsed = JSON.parse(body) as {
    ok?: boolean;
    database?: string;
    installChannel?: string;
    dataDir?: string;
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.database, "ok");
  assert.equal(parsed.installChannel, "desktop");
  assert(parsed.dataDir && !parsed.dataDir.includes(`${path.sep}disp8ch${path.sep}data`), "installed desktop app must use app-data, not repo data/");
  return child;
}

function uninstall(installDir: string) {
  const uninstaller = path.join(installDir, "Uninstall disp8ch AI.exe");
  if (fs.existsSync(uninstaller)) {
    spawnSync(uninstaller, ["/S"], {
      cwd: installDir,
      stdio: "ignore",
      timeout: 120000,
    });
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(installDir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  console.warn(`desktop-installer-smoke: warning: could not remove temp install dir ${installDir}`);
}

async function main() {
  const installer = findInstaller();
  const installDir = path.join(os.tmpdir(), `disp8ch-installer-smoke-${process.pid}`);
  let child: ChildProcess | null = null;
  try {
    taskkillDisp8ch();
    runInstaller(installer, installDir);
    child = await launchAndCheck(installDir);
    console.log("desktop-installer-smoke: ok");
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill();
    taskkillDisp8ch();
    uninstall(installDir);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
